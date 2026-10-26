import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, ExportFormat, ScheduleJob } from "./config/schema";
import { addDays, localDate } from "./core/time";

// Jobs a scheduler runs (ADR 0012). Everything here is pure: what would run, when, for which
// day, and the text of the unit that runs it. Installing it is in commands/schedule.

export type Platform = "darwin" | "linux" | "other";

export interface RunPlan {
  job: ScheduleJob;
  /** The local day the job covers, "YYYY-MM-DD". */
  date: string;
  /** The export format it uses (its destination is where the text goes). */
  format: ExportFormat;
  /** What it will do, in one line: "daily → ~/Vault/Daily/2026-10-26.md (added to the end)". */
  doing: string;
}

/** The export a job uses, and the name it's known by; says what to fix when it isn't there. */
export function formatFor(config: Config, job: ScheduleJob): ExportFormat {
  const format = config.exports.find((e) => e.name === job.format);
  if (!format)
    throw new Error(
      `${job.name} uses the export "${job.format}", which isn't in your config. Add it or run \`clockout schedule add\` again.`,
    );
  if (!format.to)
    throw new Error(
      `${job.name} uses "${job.format}", which has no destination. Give that export a \`to\` in config.toml (a file, an MCP tool or a program).`,
    );
  return format;
}

/** The day a job covers when it runs at `now`: its own day, at its own time. */
export function dateFor(job: ScheduleJob, now: Date, tz: string): string {
  const today = localDate(now, tz);
  return job.day === "yesterday" ? addDays(today, -1) : today;
}

export function planRun(
  config: Config,
  job: ScheduleJob,
  now: Date,
  describer: (format: ExportFormat, date: string) => string,
): RunPlan {
  const format = formatFor(config, job);
  const date = dateFor(job, now, config.me.timezone);
  return { job, date, format, doing: `${job.format} → ${describer(format, date)}` };
}

/** What a scheduler should run, as argv: the same runner for every platform. */
export function runnerArgv(job: ScheduleJob): string[] {
  return ["run", job.name];
}

/** A crontab line that runs the job (for cron, or when the OS units aren't used). */
export function crontabLine(job: ScheduleJob, node: string, cli: string): string {
  const [h, m] = job.at.split(":").map(Number);
  return `${m ?? 0} ${h ?? 0} * * * ${shellQuote(node)} ${shellQuote(cli)} run ${job.name} >> ${shellQuote(`${homedir()}/.local/share/clockout/schedule-${job.name}.log`)} 2>&1`;
}

/** The job as one line, for `clockout schedule`: "daily-note · 18:30 · today · daily". */
export function describeJob(job: ScheduleJob): string {
  const what = job.kind === "standup" ? `standup → ${job.format}` : `export ${job.format}`;
  return `${job.name} · ${job.at} · ${job.day} · ${what}${job.allow_open ? " · open questions ok" : ""}`;
}

export interface UnitEnv {
  node: string;
  cli: string;
  /** The PATH the job was set up with, so a helper CLI can still be found at 18:30. */
  path: string;
  env?: Record<string, string>;
  home?: string;
  logsDir?: string;
}

/** The launchd user agent that runs the job (macOS). */
export function launchdPlist(job: ScheduleJob, unit: UnitEnv): string {
  const home = unit.home ?? homedir();
  const log = join(unit.logsDir ?? join(home, "Library", "Logs"), `clockout-${job.name}.log`);
  const [h, m] = job.at.split(":").map(Number);
  const env = { PATH: unit.path, ...(unit.env ?? {}) };
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${xml(k)}</key>\n      <string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.clockout.${xml(job.name)}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(unit.node)}</string>
      <string>${xml(unit.cli)}</string>
      ${runnerArgv(job)
        .map((a) => `<string>${xml(a)}</string>`)
        .join("\n      ")}
    </array>
    <key>StartCalendarInterval</key>
    <dict>
      <key>Hour</key>
      <integer>${h ?? 18}</integer>
      <key>Minute</key>
      <integer>${m ?? 0}</integer>
    </dict>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>StandardOutPath</key>
    <string>${xml(log)}</string>
    <key>StandardErrorPath</key>
    <string>${xml(log)}</string>
    <key>RunAtLoad</key>
    <false/>
  </dict>
</plist>
`;
}

/** The systemd user service and timer that run the job (Linux). */
export function systemdUnits(job: ScheduleJob, unit: UnitEnv): { service: string; timer: string } {
  const [h, m] = job.at.split(":").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  const env = { PATH: unit.path, ...(unit.env ?? {}) };
  const envLines = Object.entries(env)
    .map(([k, v]) => `Environment="${k}=${v}"`)
    .join("\n");
  const service = `[Unit]
Description=Clockout ${job.name}

[Service]
Type=oneshot
ExecStart="${unit.node}" "${unit.cli}" ${runnerArgv(job).join(" ")}
${envLines}
`;
  const timer = `[Unit]
Description=Clockout ${job.name} at ${job.at}

[Timer]
OnCalendar=*-*-* ${pad(h ?? 18)}:${pad(m ?? 0)}:00
Persistent=true

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

/** The files the OS units live in. */
export function unitPaths(job: ScheduleJob, platform: Platform, home = homedir()) {
  if (platform === "darwin")
    return [join(home, "Library", "LaunchAgents", `com.clockout.${job.name}.plist`)];
  if (platform === "linux")
    return [
      join(home, ".config", "systemd", "user", `clockout-${job.name}.service`),
      join(home, ".config", "systemd", "user", `clockout-${job.name}.timer`),
    ];
  return [];
}

/** What to tell someone on a platform with no units: the crontab line, and where it goes. */
export function cronFallback(job: ScheduleJob, unit: UnitEnv): string {
  return `${crontabLine(job, unit.node, unit.cli)}\n\nAdd it with \`crontab -e\`, or use your system's own scheduler.`;
}

function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function shellQuote(text: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}
