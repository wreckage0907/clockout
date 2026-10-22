import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { pi, readPiSession } from "../../src/sources/pi";

const fixtures = new URL("../fixtures/pi", import.meta.url).pathname;
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
  env: { PI_CODING_AGENT_DIR: fixtures },
  resolveRepo: async (cwd: string) => repos[cwd],
};
const hhmm = (a: Activity) => a.start.toISOString().slice(11, 16);

async function collect(date: string): Promise<Activity[]> {
  const out: Activity[] = [];
  for await (const a of pi.collect(dayRange(date, "Asia/Kolkata"), { type: "pi" }, ctx)) {
    out.push(a);
  }
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

describe("pi source", () => {
  it("turns typed prompts and ! commands into human activity, with the session's name and repo", async () => {
    const prompts = (await collect("2026-10-16")).filter((a) => a.kind === "prompt");
    const acme = prompts.filter((a) => a.cwd === "/Users/dev/work/acme-api");
    expect(acme.map(hhmm)).toEqual(["05:31", "05:40", "05:45", "05:50"]);
    expect(acme[0]).toMatchObject({
      source: "pi",
      actor: "human",
      title: "Rate limit the login endpoint",
      repo: "acme/api",
      sessionId: "0a1b2c3d-0000-4000-8000-000000000001",
    });
    const clockout = prompts.filter((a) => a.cwd === "/Users/dev/code/clockout");
    expect(clockout.map(hhmm)).toEqual(["18:21"]); // 23:51 IST; the 00:05 prompt is the next day
    expect(clockout[0]?.title).toBeUndefined();
  });

  it("groups assistant replies after a prompt into one agent turn, ignoring tool results", async () => {
    const turns = (await collect("2026-10-16")).filter((a) => a.kind === "agent_turn");
    expect(turns.map((a) => [hhmm(a), a.end?.toISOString().slice(11, 19)])).toEqual([
      ["05:31", "05:33:00"],
      ["05:40", "05:42:00"],
      ["05:50", "05:50:40"],
      ["18:21", "18:23:00"],
    ]);
    expect(turns.every((a) => a.actor === "agent")).toBe(true);
  });

  it("puts the rest of a session that crosses midnight on the next day", async () => {
    const next = await collect("2026-10-17");
    expect(next.map((a) => [a.kind, hhmm(a)])).toEqual([
      ["prompt", "18:35"],
      ["agent_turn", "18:36"],
    ]);
  });

  it("finds nothing on a day without sessions", async () => {
    expect(await collect("2026-10-14")).toEqual([]);
  });

  it("counts a malformed line and leaves system messages out", async () => {
    const session = await readPiSession(
      join(
        fixtures,
        "sessions/--Users-dev-work-acme-api--/2026-10-16T05-30-00-000Z_0a1b2c3d-0000-4000-8000-000000000001.jsonl",
      ),
    );
    expect(session.skipped).toBe(1);
    expect(session.events.filter((e) => e.kind === "prompt")).toHaveLength(4);
  });

  it("is detected when its sessions folder has projects", async () => {
    expect(await pi.detect(ctx)).toEqual({ summary: expect.stringMatching(/^2 projects in /) });
    expect(await pi.detect({ ...ctx, env: { PI_CODING_AGENT_DIR: "/nowhere" } })).toBeNull();
  });
});
