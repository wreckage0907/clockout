import { loadConfig, saveConfig } from "../config/load";
import { resolvePaths, tildify } from "../config/paths";
import { type Config, type ScheduleJob, scheduleJobSchema } from "../config/schema";
import { describeDestination } from "../export/send";
import { logRun, runScheduled } from "../run";
import { type AppContext, appContext } from "./context";
import {
  printUnits,
  runScheduleAdd,
  runScheduleList,
  runScheduleLog,
  runScheduleRemove,
  runScheduleSync,
} from "./schedule";

// The thin CLI layer for `clockout schedule …` and `clockout run …`: load the config, hand the
// work to the pure parts, save what changed.

async function configAndFile(): Promise<{ config: Config; file: string }> {
  const { configFile } = resolvePaths();
  const config = await loadConfig(configFile);
  if (!config) throw new Error(`No config at ${tildify(configFile)}. Run \`clockout init\` first.`);
  return { config, file: configFile };
}

export async function scheduleList(): Promise<void> {
  const { config } = await configAndFile();
  await runScheduleList(config);
}

export interface AddOptions {
  at?: string;
  for?: string;
  format?: string;
  kind?: string;
  allowOpen?: boolean;
  print?: boolean;
}

export async function scheduleAdd(name: string, opts: AddOptions): Promise<void> {
  const { config, file } = await configAndFile();
  const existing = config.schedule.find((j) => j.name === name);
  const format = opts.format ?? existing?.format ?? config.exports.find((e) => e.to)?.name;
  if (!format)
    throw new Error(
      `Which export should ${name} send? Give one with a destination: -f <name>. None of your exports has a destination yet, so add \`to\` to one in config.toml ([ADR 0010](../docs/adr/0010-mcp-as-source-and-destination.md)).`,
    );
  const parsed = scheduleJobSchema.safeParse({
    name,
    at: opts.at ?? existing?.at ?? "18:30",
    day: opts.for ?? existing?.day ?? "today",
    kind: opts.kind ?? existing?.kind ?? "export",
    format,
    allow_open: opts.allowOpen ?? existing?.allow_open ?? false,
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${issue?.path.join(".") || name}: ${issue?.message ?? "not a usable job"}`);
  }
  const next = await runScheduleAdd(config, parsed.data, { print: opts.print });
  await saveConfig(file, next);
  if (opts.print) console.log(`\nNothing installed. Run \`clockout schedule sync\` to install it.`);
}

export async function scheduleRemove(name: string): Promise<void> {
  const { config, file } = await configAndFile();
  const next = await runScheduleRemove(config, name);
  await saveConfig(file, next);
}

export async function scheduleSync(): Promise<void> {
  const { config } = await configAndFile();
  await runScheduleSync(config);
}

export async function schedulePrint(name?: string): Promise<void> {
  const { config } = await configAndFile();
  const jobs = name ? config.schedule.filter((j) => j.name === name) : config.schedule;
  if (!jobs.length)
    throw new Error(
      name ? `There's no scheduled job called "${name}".` : "Nothing is scheduled yet.",
    );
  for (const job of jobs) {
    const format = config.exports.find((e) => e.name === job.format);
    console.log(
      `${job.name} → ${format?.to ? describeDestination(format.to, "YYYY-MM-DD") : "(no destination)"}`,
    );
    printUnits(job);
  }
}

export async function scheduleLog(): Promise<void> {
  await runScheduleLog();
}

export interface RunNowOptions {
  dryRun?: boolean;
  again?: boolean;
}

/** `clockout run <name>`: what the OS unit calls, and what you can call by hand. */
export async function runNow(name: string, opts: RunNowOptions, app?: AppContext): Promise<void> {
  const ctx = app ?? (await appContext());
  const result = await runScheduled(name, ctx.config, ctx, {
    ...(opts.dryRun ? { dryRun: true } : {}),
    ...(opts.again ? { again: true } : {}),
  });
  // A dry run is you looking, not the scheduler running: it stays out of the run log.
  if (!opts.dryRun) {
    await logRun(result.line);
    if (result.error) await logRun(`${name} error: ${result.error.message}`);
  }
  if (result.status === "written") console.log(result.line);
  else console.error(result.line);
  // The exit code is all cron can read: a partial sheet fails unless the job says it's fine.
  const job = ctx.config.schedule.find((j) => j.name === name);
  const openBad = (result.open ?? 0) > 0 && !job?.allow_open;
  if (result.status === "failed" || openBad) process.exitCode = 1;
}

export type { ScheduleJob };
