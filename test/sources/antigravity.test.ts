import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { antigravity, readAntigravityTranscript } from "../../src/sources/antigravity";
import { buildDb } from "../helpers/sqlite-fixture";

const fixtures = new URL("../fixtures/antigravity/antigravity-cli", import.meta.url).pathname;
const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
});
const repos: Record<string, string> = { "/Users/dev/work/acme-api": "acme/api" };
let home: string;
const ctx = () => ({
  config,
  homeDir: home,
  env: {},
  resolveRepo: async (cwd: string) => repos[cwd],
});
const agyDir = () => join(home, ".gemini", "antigravity-cli");
const hhmm = (a: Activity) => a.start.toISOString().slice(11, 16);

beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), "clockout-agy-"));
  await cp(fixtures, agyDir(), { recursive: true });
  await buildDb(
    join(agyDir(), "conversation_summaries.sql"),
    join(agyDir(), "conversation_summaries.db"),
  );
});
afterAll(() => rm(home, { recursive: true, force: true }));

async function collect(date: string): Promise<Activity[]> {
  const out: Activity[] = [];
  const range = dayRange(date, "Asia/Kolkata");
  for await (const a of antigravity.collect(range, { type: "antigravity" }, ctx())) out.push(a);
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

describe("antigravity source", () => {
  it("turns your inputs into human activity, with the conversation's title and workspace", async () => {
    const prompts = (await collect("2026-10-16")).filter((a) => a.kind === "prompt");
    expect(prompts.map(hhmm)).toEqual(["06:00", "06:10", "18:25"]); // 18:25 is 23:55 IST
    expect(prompts[0]).toMatchObject({
      source: "antigravity",
      actor: "human",
      title: "Add retries to the webhook sender",
      cwd: "/Users/dev/work/acme-api",
      repo: "acme/api",
      sessionId: "0a1b2c3d-0000-4000-8000-0000000000a1",
    });
  });

  it("still reads a conversation missing from the index, without a title or folder", async () => {
    const late = (await collect("2026-10-16")).find((a) => hhmm(a) === "18:25");
    expect(late?.title).toBeUndefined();
    expect(late?.cwd).toBeUndefined();
  });

  it("groups model steps after an input into one agent turn, ignoring system steps", async () => {
    const turns = (await collect("2026-10-16")).filter((a) => a.kind === "agent_turn");
    expect(turns.map((a) => [hhmm(a), a.end?.toISOString().slice(11, 19)])).toEqual([
      ["06:00", "06:01:00"],
      ["06:10", "06:11:30"],
      ["18:25", "18:25:10"],
    ]);
  });

  it("leaves out subagent conversations", async () => {
    const ids = new Set((await collect("2026-10-16")).map((a) => a.sessionId));
    expect(ids.has("0a1b2c3d-0000-4000-8000-0000000000a2")).toBe(false);
  });

  it("puts the rest of a conversation that crosses midnight on the next day", async () => {
    expect((await collect("2026-10-17")).map((a) => [a.kind, hhmm(a)])).toEqual([
      ["prompt", "18:40"],
      ["agent_turn", "18:40"],
    ]);
  });

  it("finds nothing on a day without conversations", async () => {
    expect(await collect("2026-10-14")).toEqual([]);
  });

  it("counts a malformed line", async () => {
    const id = "0a1b2c3d-0000-4000-8000-0000000000a1";
    const session = await readAntigravityTranscript(
      join(agyDir(), "brain", id, ".system_generated", "logs", "transcript.jsonl"),
      id,
    );
    expect(session.skipped).toBe(1);
    expect(session.events.filter((e) => e.kind === "prompt")).toHaveLength(2);
  });

  it("is detected when the CLI has conversations with transcripts", async () => {
    expect(await antigravity.detect(ctx())).toEqual({
      summary: "3 conversations in ~/.gemini/antigravity-cli",
    });
    expect(await antigravity.detect({ ...ctx(), homeDir: "/nowhere" })).toBeNull();
  });
});
