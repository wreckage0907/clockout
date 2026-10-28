import { basename } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import { killGroup, trackHelper } from "./ai/cli";
import { redactSecrets } from "./core/secrets";

// The escape hatch ([ADR 0009](../../docs/adr/0009-change-clockout-through-config.md), layer 4):
// run a program you name, hand it one JSON request on stdin, read one JSON answer back. No
// shell (so nothing in an argument is ever run as a command), a timeout, its own process group
// (so anything it started goes with it), and never reachable from the AI.

/** How the answer has to look: one JSON object on stdout. */
const answer = z.looseObject({});

export interface CommandResult {
  /** The JSON the program printed, `{}` when it printed nothing. */
  json: Record<string, unknown>;
  /** stderr, trimmed, for an error message (tokens redacted). */
  stderr: string;
}

export interface CommandOptions {
  /** How long it may take; a program that hangs is stopped. */
  timeoutMs?: number;
  /** What it's being asked to do, for error messages ("your timesheet program"). */
  name?: string;
  /** The working folder; the user's own by default. */
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}

/** Runs `argv` with `request` as JSON on stdin, and reads its JSON answer. */
export async function runCommand(
  argv: readonly string[],
  request: unknown,
  opts: CommandOptions = {},
): Promise<CommandResult> {
  const [program, ...args] = argv;
  if (!program) throw new Error("A command needs a program to run.");
  // Just the program's name: the whole path is noise in a message about what went wrong.
  const name = opts.name ?? basename(program);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const run = execa(program, args, {
    reject: false,
    // Its own process group, killed as a whole below: execa's own timeout and cleanup reach only
    // the program itself (and `cleanup` is ignored for a detached one).
    detached: true,
    cleanup: false,
    extendEnv: true,
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    input: JSON.stringify(request),
    preferLocal: false,
    shell: false,
  });
  const pid = run.pid;
  // On a quit (Ctrl+C, a closed terminal) the whole group goes too.
  const untrack = pid ? trackHelper(pid) : () => undefined;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (pid) killGroup(pid);
    // Where there are no process groups (Windows), at least the program itself.
    run.kill("SIGKILL");
  }, timeoutMs);
  let result: Awaited<typeof run>;
  try {
    result = await run;
  } finally {
    clearTimeout(timer);
    untrack();
  }
  const stderr = redactSecrets(result.stderr ?? "").trim();
  if (timedOut)
    throw new Error(
      `${name} didn't answer within ${Math.round(timeoutMs / 1000)} seconds, so Clockout stopped it.`,
    );
  if (result.exitCode !== 0) {
    const why = stderr.split("\n").filter(Boolean).at(-1) ?? "";
    throw new Error(`${name} failed (exit ${result.exitCode ?? "?"})${why ? `: ${why}` : ""}.`);
  }
  const said = (result.stdout ?? "").trim();
  if (!said) return { json: {}, stderr };
  let json: unknown;
  try {
    json = JSON.parse(said);
  } catch {
    throw new Error(`${name} didn't print JSON as its answer. See docs/timesheet-api.md.`);
  }
  const parsed = answer.safeParse(json);
  if (!parsed.success) throw new Error(`${name} answered with something that isn't a JSON object.`);
  return { json: parsed.data, stderr };
}

/**
 * What a program gets on stdin, and may answer with, for the five timesheet operations and for
 * an export. The same shapes as the JSON API ([timesheet-api.md](../../docs/timesheet-api.md)).
 */
export interface CommandRequest {
  op: "day" | "tasks" | "create" | "update" | "delete" | "text";
  [key: string]: unknown;
}
