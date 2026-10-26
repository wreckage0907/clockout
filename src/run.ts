import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AppContext, commandAi } from "./commands/context";
import { dayText } from "./commands/day-text";
import { resolvePaths } from "./config/paths";
import type { Config, ScheduleJob } from "./config/schema";
import { planDestination, writeDestination } from "./export/send";
import { takeLock } from "./lock";
import { logError } from "./log";
import { dateFor, formatFor } from "./schedule";
import { buildStandup } from "./standup";

// What a scheduler actually calls (`clockout run <name>`, ADR 0012). One job, one day, one
// destination: it takes the lock, skips a day it already wrote, and records what happened. The
// exit code is the only thing cron can read, so it's honest: 1 when nothing was written or the
// day still has open questions (unless the job says that's fine).

export interface RunOptions {
  now?: Date;
  /** Write even if this day was written already (the "I edited it, redo it" flag). */
  again?: boolean;
  /** Show what would happen, write nothing. */
  dryRun?: boolean;
  interactive?: boolean;
}

export interface RunResult {
  status: "written" | "skipped" | "failed";
  /** One line for the run log and the terminal. */
  line: string;
  /** The day it was about, and how many timesheet rows went in. */
  date?: string;
  rows?: number;
  open?: number;
  error?: Error;
}

/** A file per job holding the last day written, so a re-run doesn't call Notion twice. */
export function statePath(name: string, dataDir = resolvePaths().dataDir): string {
  return join(dataDir, "schedule", `${name}.json`);
}

interface JobState {
  /** The last day written, "YYYY-MM-DD". */
  date?: string;
  at?: string;
}

async function readState(path: string): Promise<JobState> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as JobState;
  } catch {
    return {};
  }
}

/** `clockout run <name>`: the job, the way a scheduler would have it. */
export async function runScheduled(
  name: string,
  config: Config,
  app: AppContext & { now?: Date },
  opts: RunOptions = {},
): Promise<RunResult> {
  const job = config.schedule.find((j) => j.name === name);
  if (!job)
    throw new Error(
      `There's no scheduled job called "${name}". Run \`clockout schedule\` to see them, or \`clockout schedule add\` to make one.`,
    );
  const now = opts.now ?? new Date();
  const paths = resolvePaths();
  const lock = join(paths.dataDir, `schedule-${name}.lock`);
  const held = await takeLock(lock, { waitMs: 5000, what: `the scheduled job ${name}` });
  if (!held)
    return {
      status: "skipped",
      line: `${name} skipped: another run of it is still going`,
    };
  try {
    return await runJob(job, config, app, opts, now, paths.dataDir);
  } finally {
    await held.release();
  }
}

async function runJob(
  job: ScheduleJob,
  config: Config,
  app: AppContext,
  opts: RunOptions,
  now: Date,
  dataDir: string,
): Promise<RunResult> {
  const state = statePath(job.name, dataDir);
  const date = dateFor(job, now, config.me.timezone);
  const before = await readState(state);
  if (!opts.again && before.date === date) {
    return {
      status: "skipped",
      date,
      line: `${job.name} skipped: ${date} was written already (--again writes it again)`,
    };
  }

  // Says what to fix when the export or its destination is gone, before anything else happens.
  const format = formatFor(config, job);
  const to = format.to;
  if (!to) throw new Error(`${job.name} uses "${job.format}", which has no destination.`);
  const ai = await commandAi(config, undefined);

  // The text: the day's rows, or the standup, through the format the job names.
  let text: string;
  let rows = 0;
  let open = 0;
  if (job.kind === "standup") {
    const standup = await buildStandup(date, date, config, app.store, {
      blockers: [],
      ai,
      log: logError,
    });
    text = standup.text;
  } else {
    const day = await dayText(job.format, date, config, app.store, ai);
    text = day.text;
    rows = day.rows;
    open = day.open;
  }

  const plan = await planDestination(to, text, {
    date,
    ...(job.kind === "standup" ? { block: "standup" as const } : {}),
  });
  const where = plan.where;
  if (opts.dryRun)
    return {
      status: "written",
      date,
      rows,
      open,
      line: `${job.name} · ${date} · would write ${plan.text.split("\n").filter(Boolean).length} lines to ${where}`,
    };

  try {
    await writeDestination(to, plan, { config });
  } catch (err) {
    return {
      status: "failed",
      date,
      rows,
      open,
      error: err as Error,
      line: `${job.name} failed for ${date}: ${(err as Error).message}`,
    };
  }
  await mkdir(dirname(state), { recursive: true, mode: 0o700 }).catch(() => undefined);
  await writeFile(state, `${JSON.stringify({ date, at: now.toISOString() })}\n`, { mode: 0o600 });
  const openNote =
    open && !job.allow_open ? ` · ${open} open question${open === 1 ? "" : "s"}` : "";
  return {
    status: "written",
    date,
    rows,
    open,
    line: `${job.name} · ${date} · ${job.kind === "standup" ? "standup" : `${rows} row${rows === 1 ? "" : "s"}`} → ${where}${openNote}`,
  };
}

/** Where a scheduled run's one-line records go. */
export function runsLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolvePaths(env).dataDir, "runs.log");
}

const RUNS_MAX = 256 * 1024;

/** Appends one line per run; never throws (a log that can't be written isn't a failure). */
export async function logRun(line: string, file = runsLogPath(), now = new Date()): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const size = await stat(file).then(
      (s) => s.size,
      () => 0,
    );
    if (size > RUNS_MAX) await writeFile(file, "");
    await appendFile(file, `${now.toISOString()} ${line}\n`, { mode: 0o600 });
  } catch {
    // The scheduler's own log has the same lines.
  }
}

/** The last `count` runs, newest first. */
export async function readRuns(count = 20, file = runsLogPath()): Promise<string[]> {
  const text = await readFile(file, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).slice(-count).reverse();
}
