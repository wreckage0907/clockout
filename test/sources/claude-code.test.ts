import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { claudeCode, isHumanPrompt, readSession } from "../../src/sources/claude-code";

const fixtures = new URL("../fixtures/claude", import.meta.url).pathname;
const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
});
const repos: Record<string, string> = {
  "/Users/dev/work/acme-api": "acme/api",
  "/Users/dev/code/clockout": "dev-example/clockout",
};
const ctx = {
  config,
  homeDir: "/home/dev",
  env: { CLAUDE_CONFIG_DIR: fixtures },
  resolveRepo: async (cwd: string) => repos[cwd],
};

async function collect(date: string): Promise<Activity[]> {
  const out: Activity[] = [];
  for await (const a of claudeCode.collect(
    dayRange(date, "Asia/Kolkata"),
    { type: "claude-code" },
    ctx,
  )) {
    out.push(a);
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

describe("claude-code source", () => {
  it("turns typed prompts into human activity, with the session's final title and repo", async () => {
    const prompts = (await collect("2026-10-16")).filter((a) => a.kind === "prompt");
    expect(prompts.map((a) => a.start.toISOString().slice(11, 16))).toEqual([
      "04:30",
      "04:52",
      "05:20",
      "06:05",
      "06:40", // acme-api, incl. one list-content prompt
      "08:30",
      "09:05",
      "09:40",
      "10:15",
      "10:55", // clockout
      "18:10", // 23:40 IST, before the session crosses midnight
    ]);
    expect(prompts[0]).toMatchObject({
      actor: "human",
      title: "Fix auth token refresh",
      repo: "acme/api",
      branch: "fix/auth-refresh",
      cwd: "/Users/dev/work/acme-api",
    });
    expect(prompts[5]).toMatchObject({
      title: "Build export command",
      repo: "dev-example/clockout",
    });
  });

  it("groups each run of assistant lines into one agent turn, ignoring subagents", async () => {
    const turns = (await collect("2026-10-16")).filter((a) => a.kind === "agent_turn");
    expect(turns).toHaveLength(11);
    expect(turns[0]).toMatchObject({ actor: "agent", start: new Date("2026-10-16T04:31:05Z") });
    expect(turns[0]?.end).toEqual(new Date("2026-10-16T04:34:10Z"));
  });

  it("puts the rest of a midnight-crossing session on the next day", async () => {
    const next = await collect("2026-10-17");
    expect(next.filter((a) => a.kind === "prompt").map((a) => a.start.toISOString())).toEqual([
      "2026-10-16T18:35:00.000Z",
      "2026-10-16T18:55:00.000Z",
    ]);
  });

  it("returns nothing for a day without sessions", async () => {
    expect(await collect("2026-10-10")).toEqual([]);
  });

  it("skips malformed lines and counts them", async () => {
    const file = `${fixtures}/projects/-Users-dev-work-acme-api/1ea2e678-a73c-5250-96a7-904e4e840e42.jsonl`;
    const s = await readSession(file);
    expect(s.skipped).toBe(1);
    expect(s.title).toBe("Fix auth token refresh");
  });
});

describe("isHumanPrompt", () => {
  it.each([
    ["typed text", "Fix the bug", true],
    ["text parts", [{ type: "text", text: "hi" }], true],
    ["tool results", [{ type: "tool_result", content: "ok" }], false],
    ["local command output", "<local-command-stdout>done</local-command-stdout>", false],
    ["missing content", undefined, false],
  ])("%s", (_, content, expected) => expect(isHumanPrompt(content)).toBe(expected));
});
