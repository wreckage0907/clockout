import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { resolvePaths, tildify } from "../config/paths";
import type { Config, ScheduleJob } from "../config/schema";
import { describeDestination, planDestination } from "../export/send";
import { logRun, readRuns } from "../run";
import {
  cronFallback,
  crontabLine,
  dateFor,
  describeJob,
  formatFor,
  launchdPlist,
  type Platform,
  systemdUnits,
  type UnitEnv,
  unitPaths,
} from "../schedule";

// `clockout schedule`: the jobs a scheduler runs, and the OS units that run them (ADR 0012).
// Adding one shows exactly what will run and where it writes, because that confirmation is the
// one you gave: after that, it writes without asking.

export interface ScheduleDeps {
  platform?: Platform;
  /** The interpreter to run Clockout with, absolute: cron and launchd have no nvm on PATH. */
  node?: string;
  /** The built CLI's path. */
  cli?: string;
  home?: string;
  env?: Record<string, string>;
  /** Runs a command, for launchctl/systemctl; tests pass a recorder. */
  exec?: (cmd: string, args: string[]) => Promise<{ failed: boolean; stderr?: string }>;
  log?: (line: string) => void;
}

export function hostPlatform(p: string = process.platform): Platform {
  if (p === "darwin") return "darwin";
  if (p === "linux") return "linux";
  return "other";
}

/** The environment a scheduled run gets: the PATH it was set up with, and Clockout's own paths. */
function jobEnv(base: Record<string, string>, home: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: base.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: home,
  };
  for (const [k, v] of Object.entries(base)) if (v) env[k] = v;
  return env;
}

export async function runScheduleList(config: Config, deps: ScheduleDeps = {}): Promise<void> {
  const say = deps.log ?? console.log;
  if (!config.schedule.length) {
    say(
      "Nothing is scheduled. Add one with `clockout schedule add <name> --at 18:30 -f <export>`.",
    );
    return;
  }
  const platform = deps.platform ?? hostPlatform();
  for (const job of config.schedule) {
    const format = config.exports.find((e) => e.name === job.format);
    const where = format?.to
      ? describeDestination(format.to, dateFor(job, new Date(), config.me.timezone))
      : `(no export called "${job.format}")`;
    // Whether the OS actually has it: a job in the config isn't a job being run.
    const state =
      platform === "other" || (await installed(job, platform, deps)) ? "" : " · not installed";
    say(`  ${describeJob(job)}${state}\n    → ${where}`);
  }
  say(
    platform === "other"
      ? "\nNo login-time unit on this system: `clockout schedule print` gives you a crontab line."
      : "\n`clockout schedule sync` installs or refreshes the units; `schedule print` shows them without touching the system.",
  );
}

/** Is the job's unit on this machine? Says nothing about whether it fires; the OS decides that. */
async function installed(
  job: ScheduleJob,
  platform: Platform,
  deps: ScheduleDeps,
): Promise<boolean> {
  const files = unitPaths(job, platform, deps.home ?? homedir());
  const found = await Promise.all(
    files.map((f) =>
      stat(f).then(
        () => true,
        () => false,
      ),
    ),
  );
  return found.length > 0 && found.every(Boolean);
}

/**
 * `clockout schedule add <name> --at 18:30 --for today -f daily [--kind standup] [--allow-open]`:
 * saves the job, shows what it will do, and installs the unit (or prints it with `--print`).
 */
export async function runScheduleAdd(
  config: Config,
  job: ScheduleJob,
  opts: { print?: boolean; install?: boolean; yes?: boolean },
  deps: ScheduleDeps = {},
): Promise<Config> {
  const say = deps.log ?? console.log;
  // It has to be a real export with a real destination: a job that fails at 18:30 is no help.
  const format = formatFor(config, job);
  if (job.kind === "standup" && !config.exports.some((e) => e.name === job.format))
    throw new Error(
      `The standup job needs an export with a destination, and "${job.format}" isn't one.`,
    );
  const existing = config.schedule.find((j) => j.name === job.name);
  const next: Config = {
    ...config,
    schedule: [...config.schedule.filter((j) => j.name !== job.name), job],
  };

  const date = dateFor(job, new Date(), config.me.timezone);
  const plan = await planDestination(format.to ?? { file: "" }, "", {
    date,
    ...(job.kind === "standup" ? { block: "standup" as const } : {}),
  });
  say(
    `${existing ? "Updated" : "Added"} ${job.name}: ${job.at} every day, for ${job.day}.\n` +
      `  It writes ${job.kind === "standup" ? "your standup" : `"${job.format}"`} to ${plan.where}\n` +
      `  That's the confirmation: after this it writes without asking. ${
        job.allow_open ? "Open questions won't fail it." : "Open questions make it exit 1."
      }`,
  );
  if (opts.print) {
    printUnits(job, deps, say);
    return next;
  }
  if (opts.install === false) return next;
  await installUnits(job, deps, say);
  return next;
}

export async function runScheduleRemove(
  config: Config,
  name: string,
  deps: ScheduleDeps = {},
): Promise<Config> {
  const say = deps.log ?? console.log;
  const job = config.schedule.find((j) => j.name === name);
  if (!job) throw new Error(`There's no scheduled job called "${name}".`);
  await uninstallUnits(job, deps);
  say(
    `Removed ${name}. Its runs log stays in ${tildify(join(resolvePaths().dataDir, "runs.log"))}.`,
  );
  return { ...config, schedule: config.schedule.filter((j) => j.name !== name) };
}

/** `clockout schedule sync`: (re)writes every job's unit from the config. */
export async function runScheduleSync(config: Config, deps: ScheduleDeps = {}): Promise<void> {
  const say = deps.log ?? console.log;
  if (!config.schedule.length) {
    say("Nothing is scheduled, so there's nothing to install.");
    return;
  }
  for (const job of config.schedule) await installUnits(job, deps, say);
}

/** `clockout schedule print [name]`: the files or the crontab line, without touching the system. */
export function printUnits(job: ScheduleJob, deps: ScheduleDeps = {}, say = console.log): void {
  const platform = deps.platform ?? hostPlatform();
  const unitEnv = unitFor(deps);
  if (platform === "darwin") {
    say(`\n${unitPaths(job, platform, deps.home ?? homedir())[0] ?? ""}:\n`);
    say(plistFor(job, unitEnv));
    return;
  }
  if (platform === "linux") {
    const { service, timer } = systemdUnits(job, unitEnv);
    say(`\nclockout-${job.name}.service:\n${service}\nclockout-${job.name}.timer:\n${timer}`);
    return;
  }
  say(`\n${cronFallback(job, unitEnv)}`);
}

/** `clockout schedule log`: what the last runs did, newest first. */
export async function runScheduleLog(): Promise<void> {
  const lines = await readRuns(20);
  if (!lines.length) {
    console.log("No scheduled run has happened yet.");
    return;
  }
  for (const line of lines) console.log(line);
}

/** Records a run's one line, wherever it was started from. */
export const recordRun = logRun;

// ── installing ───────────────────────────────────────────────────────────────

/** The interpreter, CLI and environment a job's unit should use. */
function unitFor(deps: ScheduleDeps) {
  const home = deps.home ?? homedir();
  return {
    node: deps.node ?? process.execPath,
    cli: deps.cli ?? process.argv[1] ?? "",
    path: deps.env?.PATH ?? process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    env: {
      ...jobEnv(deps.env ?? (process.env as Record<string, string>), home),
      ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
    },
    home,
  };
}

function plistFor(job: ScheduleJob, unitEnv: UnitEnv): string {
  return launchdPlist(job, unitEnv);
}

async function installUnits(
  job: ScheduleJob,
  deps: ScheduleDeps,
  say: (line: string) => void,
): Promise<void> {
  const platform = deps.platform ?? hostPlatform();
  const unitEnv = unitFor(deps);
  if (platform === "other") {
    say(`\n${cronFallback(job, unitEnv)}`);
    return;
  }
  const files = unitPaths(job, platform, deps.home ?? homedir());
  for (const file of files) {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, unitFile(job, platform, unitEnv, file), { mode: 0o644 });
  }
  const run = deps.exec ?? defaultExec;
  if (platform === "darwin") {
    const plist = files[0] ?? "";
    const domain = `gui/${process.getuid?.() ?? 501}`;
    // bootstrap refuses an old copy: bootout first, and don't care if there was nothing to remove.
    await run("launchctl", ["bootout", domain, plist]);
    const loaded = await run("launchctl", ["bootstrap", domain, plist]);
    if (loaded.failed) {
      say(
        `Wrote ${tildify(plist)}. Loading it failed${loaded.stderr ? `: ${loaded.stderr.split("\n")[0]}` : ""}.\nLoad it with: launchctl bootstrap ${domain} ${tildify(plist)}`,
      );
      return;
    }
    say(`Installed ${job.name}: launchd runs it at ${job.at} every day.`);
    return;
  }
  const timer = `clockout-${job.name}.timer`;
  await run("systemctl", ["--user", "daemon-reload"]);
  const enabled = await run("systemctl", ["--user", "enable", "--now", timer]);
  if (enabled.failed) {
    say(
      `Wrote the unit files in ~/.config/systemd/user. Enabling it failed${
        enabled.stderr ? `: ${enabled.stderr.split("\n")[0]}` : ""
      }.\nEnable it with: systemctl --user enable --now ${timer}`,
    );
    return;
  }
  say(
    `Installed ${job.name}: systemd runs it at ${job.at} every day.\nOn a machine where you're not logged in, run \`loginctl enable-linger $USER\` once.`,
  );
}

async function uninstallUnits(job: ScheduleJob, deps: ScheduleDeps): Promise<void> {
  const platform = deps.platform ?? hostPlatform();
  const run = deps.exec ?? defaultExec;
  const home = deps.home ?? homedir();
  if (platform === "darwin") {
    const plist =
      unitPaths(job, platform, home)[0] ??
      join(home, "Library", "LaunchAgents", `com.clockout.${job.name}.plist`);
    await run("launchctl", ["bootout", `gui/${process.getuid?.() ?? 501}`, plist]);
    await rm(plist, { force: true });
    return;
  }
  if (platform === "linux") {
    await run("systemctl", ["--user", "disable", "--now", `clockout-${job.name}.timer`]);
    for (const file of unitPaths(job, platform, home)) await rm(file, { force: true });
    await run("systemctl", ["--user", "daemon-reload"]);
    return;
  }
  await rm(join(resolvePaths().dataDir, "schedule", `${job.name}.json`), { force: true });
}

/** The file's contents: a plist on macOS, the two units on Linux. */
function unitFile(job: ScheduleJob, platform: Platform, unitEnv: UnitEnv, file: string): string {
  if (platform === "darwin") return plistFor(job, unitEnv);
  const { service, timer } = systemdUnits(job, unitEnv);
  return file.endsWith(".timer") ? timer : service;
}

async function defaultExec(cmd: string, args: string[]) {
  const r = await execa(cmd, args, { reject: false }).catch((err: unknown) => ({
    failed: true,
    stderr: (err as Error).message,
  }));
  return { failed: r.failed ?? false, stderr: r.stderr ?? "" };
}

/** Kept for the CLI's own text: what a crontab line looks like for this job. */
export function showCrontab(job: ScheduleJob, deps: ScheduleDeps = {}): string {
  const unitEnv = unitFor(deps);
  return crontabLine(job, unitEnv.node, unitEnv.cli);
}
