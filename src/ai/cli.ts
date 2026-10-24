import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { execa } from "execa";
import { z } from "zod";
import { redactSecrets } from "../core/secrets";

/** Every AI call runs in a fresh folder with this prefix; sources skip sessions started in one. */
export const TEMP_PREFIX = "clockout-ai-";

/** What a CLI printed. Throws only when it couldn't be started or timed out. */
export interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs an agent CLI; tests replace it. */
export type Runner = (
  cmd: string,
  args: string[],
  opts: { input: string; cwd: string; env?: Record<string, string> },
) => Promise<Ran>;

/**
 * Runs an agent CLI in its own process group, so that on a timeout, or when Clockout quits
 * (Ctrl+C, a closed terminal), the whole group goes: agent CLIs start processes of their own,
 * which would otherwise keep running and keep the output open.
 */
export function cliRunner(timeoutMs: number): Runner {
  return async (cmd, args, { input, cwd, env }) => {
    const sub = execa(cmd, args, {
      input,
      cwd,
      reject: false,
      detached: true,
      cleanup: false,
      ...(env ? { env } : {}),
    });
    const pid = sub.pid;
    if (pid) helpers.add(pid);
    watchExit();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid) killGroup(pid);
    }, timeoutMs);
    try {
      const r = await sub;
      if (timedOut) throw new Error(`didn't answer within ${minutes(timeoutMs)}`);
      if (r.failed && r.exitCode === undefined)
        throw new Error(r.code === "ENOENT" ? "isn't installed" : "couldn't be started");
      return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode ?? 1 };
    } finally {
      clearTimeout(timer);
      if (pid) helpers.delete(pid);
    }
  };
}

export const runCli: Runner = cliRunner(120_000);

function minutes(ms: number): string {
  const [n, unit] =
    ms >= 60_000 ? [Math.round(ms / 60_000), "minute"] : [Math.ceil(ms / 1000), "second"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Process groups of helpers still running, and temp folders still in use. */
const helpers = new Set<number>();
const folders = new Set<string>();

function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/** Stops every helper still running and removes their folders; for when Clockout quits. */
export function stopHelpers(): void {
  for (const pid of helpers) killGroup(pid);
  helpers.clear();
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
  folders.clear();
}

let watching = false;
function watchExit(): void {
  if (watching) return;
  watching = true;
  process.once("exit", stopHelpers);
  // A signal skips "exit" handlers unless something handles it; quit the usual way after cleaning up.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)
    process.once(signal, () => {
      stopHelpers();
      process.exit(code);
    });
}

/** First word of `<cmd> --version`, or null when it isn't on PATH. */
export async function cliVersion(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const { stdout } = await execa(cmd, ["--version"], { env, timeout: 10_000 });
    return stdout.trim().match(/\d+\.\d+[\w.-]*/)?.[0] ?? (stdout.trim().split(/\s+/)[0] || null);
  } catch {
    return null;
  }
}

/** An empty folder for one call, with an empty `work` folder inside for the agent. */
export async function inTempDir<T>(fn: (dir: string, work: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const work = join(dir, "work");
  folders.add(dir);
  try {
    await mkdir(work);
    return await fn(dir, work);
  } finally {
    folders.delete(dir);
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Asks twice at most: `once` returns the raw value or throws when the CLI itself failed (which
 * isn't retried); a value that doesn't fit the schema is asked for again.
 */
export async function validated<T>(
  name: string,
  schema: z.ZodType<T>,
  once: () => Promise<unknown>,
): Promise<T> {
  let problem = "";
  let cause: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await once();
    if (raw === undefined) {
      problem = "unreadable output";
      cause = new Error("no JSON object in the answer");
      continue;
    }
    const value = schema.safeParse(withoutNulls(raw));
    if (value.success) return value.data;
    problem = "output didn't match the expected shape";
    cause = value.error;
  }
  throw new Error(`${name}: ${problem}.`, { cause });
}

/** JSON Schema for a zod schema, without the "$schema" draft marker CLIs don't resolve. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * The strict form OpenAI's structured output wants: every property required (optional ones may
 * be null instead) and anyOf for oneOf. `withoutNulls` turns the nulls back into absent keys.
 */
export function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k === "oneOf" ? "anyOf" : k] = strictSchema(v);
  const props = out.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const required = new Set(Array.isArray(out.required) ? out.required : []);
    const all = props as Record<string, unknown>;
    for (const [k, v] of Object.entries(all)) if (!required.has(k)) all[k] = nullable(v);
    out.required = Object.keys(all);
    out.additionalProperties = false;
  }
  return out;
}

function nullable(node: unknown): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const n = node as Record<string, unknown>;
  if (typeof n.type === "string" && !("const" in n) && !("enum" in n))
    return { ...n, type: [n.type, "null"] };
  return { anyOf: [n, { type: "null" }] };
}

/** Drops null object values, so a strict answer's "not given" reads as an absent key. */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, withoutNulls(v)]),
  );
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The JSON object in a model's plain-text reply, with or without a code fence around it. */
export function jsonIn(text: string): unknown {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t)?.[1];
  const direct = parseJson(fenced ?? t);
  if (direct !== undefined) return direct;
  const from = t.indexOf("{");
  const to = t.lastIndexOf("}");
  return from >= 0 && to > from ? parseJson(t.slice(from, to + 1)) : undefined;
}

/** For CLIs that can't enforce a schema: the instructions say what to answer with. */
export function answerWith(system: string, schema: z.ZodType): string {
  return `${system}

Answer with one JSON object and nothing else (no prose, no code fence). It must match this JSON Schema:
${JSON.stringify(jsonSchema(schema))}`;
}

/** The useful last line a CLI wrote about a failure, without ANSI colours. */
export function lastLine(text: string): string {
  const lines = stripVTControlCharacters(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

/**
 * A CLI's own words about a failure, shortened, plus how to sign in again when that's the
 * problem ("Not logged in", "401", "invalid API key").
 */
export function cliFailure(name: string, raw: string, signIn: string): Error {
  // On screen too, and maybe in a demo or a pasted bug report: no tokens it may have echoed.
  const said = redactSecrets(raw);
  const short = said.length > 200 ? `${said.slice(0, 199)}…` : said;
  const auth =
    /not (?:logged|signed) in|log ?in\b|sign ?in\b|unauthori[sz]ed|\b401\b|api key|credential|access token|expired/i.test(
      said,
    );
  const hint = auth ? ` Not signed in, or the sign-in expired: ${signIn}` : "";
  return new Error(`${name}: ${short.replace(/\.$/, "")}.${hint}`);
}
