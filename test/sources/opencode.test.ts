import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { opencode, readOpencodeSessions } from "../../src/sources/opencode";
import { buildDb } from "../helpers/sqlite-fixture";

const sql = new URL("../fixtures/opencode/opencode.sql", import.meta.url).pathname;
const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
});
const repos: Record<string, string> = {
  "/Users/dev/work/acme-api": "acme/api",
  "/Users/dev/code/clockout": "dev-example/clockout",
};
let dataHome: string;
const ctx = () => ({
  config,
  homeDir: "/home/dev",
  env: { XDG_DATA_HOME: dataHome },
  resolveRepo: async (cwd: string) => repos[cwd],
});
const hhmm = (a: Activity) => a.start.toISOString().slice(11, 16);

beforeAll(async () => {
  dataHome = await mkdtemp(join(tmpdir(), "clockout-opencode-"));
  await mkdir(join(dataHome, "opencode"));
  await buildDb(sql, join(dataHome, "opencode", "opencode.db"));
});
afterAll(() => rm(dataHome, { recursive: true, force: true }));

async function collect(date: string): Promise<Activity[]> {
  const out: Activity[] = [];
  const range = dayRange(date, "Asia/Kolkata");
  for await (const a of opencode.collect(range, { type: "opencode" }, ctx())) out.push(a);
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

describe("opencode source", () => {
  it("turns typed prompts into human activity, with the session's title and repo", async () => {
    const prompts = (await collect("2026-10-16")).filter((a) => a.kind === "prompt");
    expect(prompts.map((a) => [hhmm(a), a.repo])).toEqual([
      ["08:00", "acme/api"],
      ["08:12", "acme/api"],
      ["18:20", "dev-example/clockout"], // 23:50 IST; the 00:05 prompt is the next day
    ]);
    expect(prompts[0]).toMatchObject({
      source: "opencode",
      actor: "human",
      title: "Paginate the invoices endpoint",
      cwd: "/Users/dev/work/acme-api",
      sessionId: "ses_0a1b2c3d4ffeAcmeInvoices01",
    });
    expect(prompts[2]?.title).toBeUndefined(); // still "New session - …"
  });

  it("leaves out Clockout's own AI calls, run in its temp folders", async () => {
    const ids = new Set((await collect("2026-10-16")).map((a) => a.sessionId));
    expect(ids.has("ses_0a1b2c3d4ffeClockoutAi05")).toBe(false);
  });

  it("spans an agent turn from the first reply to the last one completing", async () => {
    const turns = (await collect("2026-10-16")).filter((a) => a.kind === "agent_turn");
    expect(turns.map((a) => [hhmm(a), a.end?.toISOString().slice(11, 19)])).toEqual([
      ["08:00", "08:02:40"],
      ["08:12", "08:14:00"],
      ["18:20", "18:22:00"],
    ]);
  });

  it("leaves out subagent sessions", async () => {
    const ids = new Set((await collect("2026-10-16")).map((a) => a.sessionId));
    expect(ids.has("ses_0a1b2c3d4ffeAcmeExplore02")).toBe(false);
  });

  it("puts the rest of a session that crosses midnight on the next day", async () => {
    expect((await collect("2026-10-17")).map((a) => [a.kind, hhmm(a)])).toEqual([
      ["prompt", "18:35"],
      ["agent_turn", "18:35"],
    ]);
  });

  it("finds nothing on a day without sessions", async () => {
    expect(await collect("2026-10-14")).toEqual([]);
  });

  it("counts a message that isn't JSON and ignores empty prompts and app messages", async () => {
    const [session] = await readOpencodeSessions(
      join(dataHome, "opencode", "opencode.db"),
      dayRange("2026-10-16", "UTC"),
    );
    expect(session?.skipped).toBe(1);
    expect(session?.events.filter((e) => e.kind === "prompt")).toHaveLength(2);
  });

  it("is detected when its database has sessions", async () => {
    expect(await opencode.detect(ctx())).toEqual({
      summary: expect.stringMatching(/^3 sessions in .*opencode\.db$/),
    });
    expect(await opencode.detect({ ...ctx(), env: { XDG_DATA_HOME: "/nowhere" } })).toBeNull();
  });
});
