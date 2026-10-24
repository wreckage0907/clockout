import { chmod, cp, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    const bySession = (cwd: string) => prompts.filter((a) => a.cwd === cwd);
    const acme = bySession("/Users/dev/work/acme-api");
    const clockout = bySession("/Users/dev/code/clockout");
    expect(acme.map((a) => a.start.toISOString().slice(11, 16))).toEqual([
      ...["04:30", "04:36", "04:44", "04:49", "04:58", "05:05", "05:11", "05:19", "05:24", "05:33"],
      ...["06:00", "06:07", "06:12", "06:20", "06:26", "06:33", "06:38"],
      "18:10", // the midnight-crossing session, 23:40 IST
    ]);
    expect(clockout).toHaveLength(22);
    expect(acme[0]).toMatchObject({
      actor: "human",
      title: "Fix auth token refresh",
      repo: "acme/api",
      branch: "fix/auth-refresh",
    });
    expect(acme[3]?.start.toISOString()).toBe("2026-10-16T04:49:00.000Z"); // list-content prompt
    expect(clockout[0]).toMatchObject({
      title: "Build export command",
      repo: "dev-example/clockout",
    });
  });

  it("groups each run of assistant lines into one agent turn, ignoring subagents", async () => {
    const all = await collect("2026-10-16");
    const turns = all.filter((a) => a.kind === "agent_turn");
    expect(turns).toHaveLength(all.filter((a) => a.kind === "prompt").length);
    expect(turns[0]).toMatchObject({ actor: "agent", start: new Date("2026-10-16T04:30:40Z") });
    expect(turns[0]?.end).toEqual(new Date("2026-10-16T04:32:00Z"));
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

  it("says when its folder is missing, instead of showing an empty day", async () => {
    const run = async () => {
      for await (const _ of claudeCode.collect(
        dayRange("2026-10-16", "Asia/Kolkata"),
        { type: "claude-code", projects_dir: "/nowhere/projects" },
        ctx,
      )) {
      }
    };
    await expect(run()).rejects.toThrow("Claude Code: no folder at /nowhere/projects");
  });

  it("skips a session it can't read and keeps the rest", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clockout-claude-"));
    await cp(join(fixtures, "projects"), join(dir, "projects"), { recursive: true });
    const [project] = await readdir(join(dir, "projects"));
    const [file] = (await readdir(join(dir, "projects", project ?? ""))).filter((f) =>
      f.endsWith(".jsonl"),
    );
    const locked = join(dir, "projects", project ?? "", file ?? "");
    await chmod(locked, 0o000);
    const out: Activity[] = [];
    for await (const a of claudeCode.collect(
      dayRange("2026-10-16", "Asia/Kolkata"),
      { type: "claude-code" },
      { ...ctx, env: { CLAUDE_CONFIG_DIR: dir } },
    ))
      out.push(a);
    await chmod(locked, 0o600);
    expect(out.length).toBeGreaterThan(0);
  });

  it("counts only what you sent, not messages Claude Code wrote in your place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clockout-claude-"));
    const file = join(dir, "s.jsonl");
    const user = (at: string, extra: object) =>
      JSON.stringify({
        type: "user",
        timestamp: `2026-10-16T${at}:00Z`,
        sessionId: "s",
        message: { role: "user", content: "text" },
        ...extra,
      });
    await writeFile(
      file,
      [
        user("05:00", { origin: { kind: "human" }, promptSource: "typed" }),
        user("05:10", { origin: { kind: "task-notification" }, promptSource: "system" }),
        user("05:20", { origin: { kind: "peer" } }),
        user("05:30", { isCompactSummary: true }),
        user("05:40", {}), // older logs don't say who sent it
      ].join("\n"),
    );
    const { events } = await readSession(file);
    expect(events.map((e) => e.at.toISOString().slice(11, 16))).toEqual(["05:00", "05:40"]);
  });
});
