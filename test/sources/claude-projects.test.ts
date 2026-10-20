import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import { claudeCode } from "../../src/sources/claude-code";
import { listClaudeProjects } from "../../src/sources/claude-code/paths";

const fixtures = new URL("../fixtures/claude", import.meta.url).pathname;
const ctx = { homeDir: "/Users/dev", env: { CLAUDE_CONFIG_DIR: fixtures } };

describe("claude-code projects", () => {
  it("lists project folders with their working directory and session counts", async () => {
    const projects = await listClaudeProjects(ctx, new Date(0));
    expect(projects).toEqual([
      {
        folder: "-Users-dev-work-acme-api",
        path: "~/work/acme-api",
        name: "acme-api",
        sessions: 2,
        recent: 2,
      },
      {
        folder: "-Users-dev-code-clockout",
        path: "~/code/clockout",
        name: "clockout",
        sessions: 1,
        recent: 1,
      },
    ]);
  });

  it("skips excluded folders when collecting", async () => {
    const config = configSchema.parse({
      me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
    });
    const seen = new Set<string>();
    for await (const a of claudeCode.collect(
      { from: new Date(0), to: dayRange("2030-01-01", "UTC").to },
      { type: "claude-code", exclude: ["-Users-dev-work-acme-api"] },
      { ...ctx, config, resolveRepo: async () => undefined },
    ))
      if (a.cwd) seen.add(a.cwd);
    expect([...seen]).toEqual(["/Users/dev/code/clockout"]);
  });
});
