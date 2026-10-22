import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { codex, readCodexSession } from "../../src/sources/codex";

const fixtures = new URL("../fixtures/codex", import.meta.url).pathname;
const days = join(fixtures, "sessions/2026/10/16");
const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
});
const ctx = {
  config,
  homeDir: "/home/dev",
  env: { CODEX_HOME: fixtures },
  // The log's own git remote wins; this is only asked for sessions without one.
  resolveRepo: async (cwd: string) => (cwd === "/Users/dev/scratch" ? undefined : "wrong/repo"),
};
const hhmm = (a: Activity) => a.start.toISOString().slice(11, 16);

async function collect(date: string): Promise<Activity[]> {
  const out: Activity[] = [];
  for await (const a of codex.collect(dayRange(date, "Asia/Kolkata"), { type: "codex" }, ctx)) {
    out.push(a);
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

describe("codex source", () => {
  it("turns user_message events into prompts, with branch and repo from the session's git info", async () => {
    const prompts = (await collect("2026-10-16")).filter((a) => a.kind === "prompt");
    // Not the injected user/developer context at 07:00, not the review subagent at 07:20,
    // and not the 00:10 IST prompt of the late session.
    expect(prompts.map(hhmm)).toEqual(["07:01", "07:15", "18:16"]);
    expect(prompts[0]).toMatchObject({
      source: "codex",
      actor: "human",
      repo: "acme/api",
      branch: "fix/rate-limit",
      cwd: "/Users/dev/work/acme-api",
      sessionId: "0b2c3d4e-0000-4000-8000-000000000001",
    });
    expect(prompts[1]?.cwd).toBe("/Users/dev/work/acme-api/web"); // from the newer turn_context
    expect(prompts[2]).not.toHaveProperty("repo");
    expect(prompts.every((a) => a.title === undefined)).toBe(true); // Codex titles are the full prompt
  });

  it("groups model output after a prompt into one agent turn", async () => {
    const turns = (await collect("2026-10-16")).filter((a) => a.kind === "agent_turn");
    expect(turns.map((a) => [hhmm(a), a.end?.toISOString().slice(11, 19)])).toEqual([
      ["07:01", "07:04:00"],
      ["07:15", "07:20:00"],
      ["18:16", "18:19:00"],
    ]);
  });

  it("puts the rest of a session that crosses midnight on the next day", async () => {
    const next = await collect("2026-10-17");
    expect(next.map((a) => [a.kind, hhmm(a)])).toEqual([
      ["prompt", "18:40"],
      ["agent_turn", "18:40"],
    ]);
  });

  it("finds nothing on a day without sessions", async () => {
    expect(await collect("2026-10-14")).toEqual([]);
  });

  it("counts a malformed line and skips subagent sessions", async () => {
    const main = await readCodexSession(
      join(days, "rollout-2026-10-16T12-30-00-0b2c3d4e-0000-4000-8000-000000000001.jsonl"),
    );
    expect(main.skipped).toBe(1);
    const review = await readCodexSession(
      join(days, "rollout-2026-10-16T12-50-00-0b2c3d4e-0000-4000-8000-000000000002.jsonl"),
    );
    expect(review.events).toEqual([]);
  });

  it("is detected when it has rollouts", async () => {
    expect(await codex.detect(ctx)).toEqual({ summary: expect.stringMatching(/^3 sessions in /) });
    expect(await codex.detect({ ...ctx, env: { CODEX_HOME: "/nowhere" } })).toBeNull();
  });
});
