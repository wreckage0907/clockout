import { readFile } from "node:fs/promises";
import { type Config, configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { createCalendarSource } from "../../src/sources/calendar";
import { claudeCode } from "../../src/sources/claude-code";
import { createGitHubSource } from "../../src/sources/github";

export const FIXTURE_DATE = "2026-10-16";
const fixtures = new URL("../fixtures/", import.meta.url);

export const fixtureRepos: Record<string, string> = {
  "/Users/dev/work/acme-api": "acme/api",
  "/Users/dev/code/clockout": "dev-example/clockout",
};

export function fixtureConfig(overrides: Partial<Config> = {}): Config {
  return configSchema.parse({
    me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
    sources: [
      { type: "claude-code" },
      { type: "github" },
      { type: "calendar", method: "ics", url: "https://cal.example/secret.ics" },
    ],
    ...overrides,
  });
}

/** Every activity the three MVP sources produce for the fixture day. */
export async function fixtureActivities(date = FIXTURE_DATE, config = fixtureConfig()) {
  const ctx = {
    config,
    homeDir: "/home/dev",
    env: { CLAUDE_CONFIG_DIR: new URL("claude", fixtures).pathname },
    resolveRepo: async (cwd: string) => fixtureRepos[cwd],
  };
  const range = dayRange(date, config.me.timezone);
  const ics = await readFile(new URL("ics/calendar.ics", fixtures), "utf8");
  const gh = JSON.parse(
    await readFile(new URL("github/contributions-2026-10-16.json", fixtures), "utf8"),
  );
  const out: Activity[] = [];
  for await (const a of claudeCode.collect(range, { type: "claude-code" }, ctx)) out.push(a);
  for await (const a of createGitHubSource(async () => gh).collect(range, { type: "github" }, ctx))
    out.push(a);
  const cal = {
    type: "calendar" as const,
    method: "ics" as const,
    url: "https://cal.example/secret.ics",
  };
  for await (const a of createCalendarSource(async () => ics).collect(range, cal, ctx)) out.push(a);
  return out;
}
