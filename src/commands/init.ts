import { access, constants, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import * as p from "@clack/prompts";
import { execa } from "execa";
import { z } from "zod";
import { BACKEND_NAMES, detectBackends } from "../ai";
import { loadConfig, saveConfig } from "../config/load";
import { resolvePaths, tildify } from "../config/paths";
import { type ConfigInput, isTimeZone, type SourceConfig } from "../config/schema";
import { fileError } from "../files";
import { antigravity } from "../sources/antigravity";
import { detectClaudeCode } from "../sources/claude-code/paths";
import { codex } from "../sources/codex";
import { gitHubStatus } from "../sources/github/token";
import { HAS_BUILT_IN_CLIENT } from "../sources/google-calendar/oauth";
import { opencode } from "../sources/opencode";
import { pi } from "../sources/pi";
import type { Detected } from "../sources/types";
import { runConnect } from "./connect";

export interface Detections {
  claudeCode: Detected | null;
  pi: Detected | null;
  codex: Detected | null;
  opencode: Detected | null;
  antigravity: Detected | null;
  github: Detected | null;
  /** Agent CLIs that can be the AI helper, in the order "auto" tries them. */
  helpers: { name: string; version: string }[];
}

export interface InitAnswers {
  name: string;
  emails: string[];
  timezone: string;
  workingHours: string;
  icsUrl?: string;
  /** "auto" rather than a named helper, so a helper that goes missing never stops Clockout. */
  ai: "auto" | "none";
}

/** Pure: answers + what was found on this machine → config to write. */
export function buildConfig(answers: InitAnswers, found: Detections): ConfigInput {
  const sources: SourceConfig[] = [];
  if (found.claudeCode) sources.push({ type: "claude-code" });
  if (found.pi) sources.push({ type: "pi" });
  if (found.codex) sources.push({ type: "codex" });
  if (found.opencode) sources.push({ type: "opencode" });
  if (found.antigravity) sources.push({ type: "antigravity" });
  if (found.github) sources.push({ type: "github" });
  if (answers.icsUrl) sources.push({ type: "calendar", method: "ics", url: answers.icsUrl });
  return {
    me: { name: answers.name, emails: answers.emails, timezone: answers.timezone },
    day: { working_hours: answers.workingHours, idle_cutoff: "20m", round_to: "15m" },
    ai: { backend: answers.ai },
    sources,
  };
}

export function parseEmails(input: string): string[] {
  return input
    .split(/[,\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);
}

const emailList = z.array(z.email()).min(1);
const httpsUrl = z.url({ protocol: /^(https|webcal)$/ });

export async function runInit(opts: { force?: boolean }): Promise<void> {
  if (!process.stdin.isTTY) {
    throw new Error("clockout init asks questions, so it needs an interactive terminal.");
  }
  const env = process.env;
  const home = homedir();
  const { configFile } = resolvePaths(env, home);

  // Before the questions, not after them: a folder it can't write fails now.
  await mkdir(dirname(configFile), { recursive: true, mode: 0o700 })
    .then(() => access(dirname(configFile), constants.W_OK))
    .catch((err: unknown) => {
      throw fileError(configFile, err);
    });

  p.intro("clockout init");

  if (!opts.force && (await loadConfig(configFile).catch(() => "invalid"))) {
    const replace = await p.confirm({
      message: `A config already exists at ${tildify(configFile, home)}. Replace it?`,
      initialValue: false,
    });
    if (p.isCancel(replace) || !replace) return cancelled("Kept your existing config.");
  }

  const spin = p.spinner();
  spin.start("Looking for your tools");
  const ctx = { homeDir: home, env };
  const [
    claudeCode,
    piFound,
    codexFound,
    opencodeFound,
    agyFound,
    github,
    helpers,
    gitName,
    gitEmail,
  ] = await Promise.all([
    detectClaudeCode(ctx),
    pi.detect(ctx),
    codex.detect(ctx),
    opencode.detect(ctx),
    antigravity.detect(ctx),
    gitHubStatus(env),
    detectBackends(env),
    gitConfig("user.name"),
    gitConfig("user.email"),
  ]);
  spin.stop("Checked your tools");
  const found: Detections = {
    claudeCode,
    pi: piFound,
    codex: codexFound,
    opencode: opencodeFound,
    antigravity: agyFound,
    github: github.found,
    helpers,
  };

  p.log.message(
    [
      claudeCode
        ? `✓ Claude Code sessions: ${claudeCode.summary}`
        : "✗ Claude Code sessions: none found",
      ...(piFound ? [`✓ Pi sessions: ${piFound.summary}`] : []),
      ...(codexFound ? [`✓ Codex sessions: ${codexFound.summary}`] : []),
      ...(opencodeFound ? [`✓ opencode sessions: ${opencodeFound.summary}`] : []),
      ...(agyFound ? [`✓ Antigravity conversations: ${agyFound.summary}`] : []),
      github.found
        ? `✓ GitHub: ${github.found.summary}`
        : `✗ GitHub: ${github.fix}, then run \`clockout init\` again.`,
      helpers[0]
        ? `✓ AI helper: ${helpers.map((h) => `${h.name} ${h.version}`).join(", ")}; writes descriptions and reads typed corrections on your own subscription`
        : `✗ AI helper: none found (${BACKEND_NAMES}). Descriptions will use session and PR titles, and typed corrections need one`,
    ].join("\n"),
  );

  const name = await p.text({
    message: "Your name",
    defaultValue: gitName ?? undefined,
    placeholder: gitName ?? "Ada Lovelace",
    validate: (v) => (!v && !gitName ? "Enter your name" : undefined),
  });
  if (p.isCancel(name)) return cancelled();

  const emails = await p.text({
    message: "Email(s) your calendar invites go to (comma-separated)",
    defaultValue: gitEmail ?? undefined,
    placeholder: gitEmail ?? "you@company.com",
    validate: (v) =>
      emailList.safeParse(parseEmails(v || gitEmail || "")).success
        ? undefined
        : "Enter one or more valid email addresses",
  });
  if (p.isCancel(emails)) return cancelled();

  const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const timezone = await p.text({
    message: "Time zone",
    defaultValue: systemTz,
    placeholder: systemTz,
    validate: (v) => (!v || isTimeZone(v) ? undefined : "Use an IANA name like Asia/Kolkata"),
  });
  if (p.isCancel(timezone)) return cancelled();

  const workingHours = await p.text({
    message: "Working hours",
    defaultValue: "09:30-18:30",
    placeholder: "09:30-18:30",
    validate: (v) =>
      !v || /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/.test(v)
        ? undefined
        : 'Use "HH:MM-HH:MM", e.g. 09:30-18:30',
  });
  if (p.isCancel(workingHours)) return cancelled();

  const calendarChoice = await p.select({
    message: "Calendar (for meetings and your RSVPs)",
    // Until Clockout ships its own Google client, signing in needs a one-time setup first.
    initialValue: HAS_BUILT_IN_CLIENT || process.env.CLOCKOUT_GOOGLE_CLIENT_ID ? "google" : "ics",
    options: [
      {
        value: "google" as const,
        label: "Sign in with Google",
        hint: HAS_BUILT_IN_CLIENT ? "once; read-only" : "read-only; needs a one-time Google setup",
      },
      { value: "ics" as const, label: "Paste a private calendar address (ICS)" },
      { value: "none" as const, label: "Skip for now" },
    ],
  });
  if (p.isCancel(calendarChoice)) return cancelled();

  let icsUrl: string | symbol = "";
  if (calendarChoice === "ics") {
    p.note(
      [
        "Google Calendar → Settings → Settings for my calendars → your calendar →",
        'Integrate calendar → "Secret address in iCal format".',
        "Work accounts often have this turned off; use Sign in with Google instead.",
      ].join("\n"),
      "Calendar",
    );
    icsUrl = await p.text({
      message: "Private calendar address (ICS)",
      placeholder: "https://calendar.google.com/calendar/ical/…/basic.ics",
      validate: (v) =>
        !v || httpsUrl.safeParse(v).success ? undefined : "Paste the full https:// address",
    });
    if (p.isCancel(icsUrl)) return cancelled();
  }

  let ai: InitAnswers["ai"] = "auto";
  if (helpers[0]) {
    const choice = await p.select({
      message: "AI for descriptions and voice corrections",
      initialValue: "auto" as const,
      options: [
        {
          value: "auto" as const,
          label: helpers[0].name,
          hint: "on your own subscription, no API key; pick another in Setup (ctrl+p)",
        },
        { value: "none" as const, label: "None", hint: "use session and PR titles" },
      ],
    });
    if (p.isCancel(choice)) return cancelled();
    ai = choice;
  }

  const config = buildConfig(
    {
      name: name || gitName || "",
      emails: parseEmails(emails || gitEmail || ""),
      timezone: timezone || systemTz,
      workingHours: workingHours || "09:30-18:30",
      icsUrl: (typeof icsUrl === "string" && icsUrl) || undefined,
      ai,
    },
    found,
  );
  await saveConfig(configFile, config);

  if (calendarChoice === "google") {
    p.outro(`Saved ${tildify(configFile, home)}. Now connecting Google Calendar…`);
    await runConnect("google");
    return;
  }
  p.outro(`Saved ${tildify(configFile, home)}. Edit it any time to add project rules.`);
}

function cancelled(message = "Nothing was saved."): void {
  p.cancel(message);
}

async function gitConfig(key: string): Promise<string | null> {
  try {
    const { stdout } = await execa("git", ["config", "--global", key], { timeout: 5000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
