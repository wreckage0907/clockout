import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDay } from "../../src/collect";
import { DayStore } from "../../src/store/json-store";
import { FIXTURE_DATE, fixtureConfig } from "../helpers/fixture-day";

const claudeDir = new URL("../fixtures/claude", import.meta.url).pathname;
const config = fixtureConfig({ sources: [{ type: "claude-code" }] });
const ctx = (dir: string) => ({
  homeDir: "/home/dev",
  env: { CLAUDE_CONFIG_DIR: dir },
  resolveRepo: async () => "acme/api",
});

async function store() {
  return new DayStore(await mkdtemp(join(tmpdir(), "clockout-store-")));
}

describe("openDay", () => {
  it("builds the day from fresh activity and saves it with dates intact", async () => {
    const s = await store();
    const { stored, kept } = await openDay(FIXTURE_DATE, config, s, { ctx: ctx(claudeDir) });
    expect(kept).toBe(false);
    expect(stored.day.blocks.length).toBeGreaterThan(0);
    const loaded = await s.load(FIXTURE_DATE);
    expect(loaded?.day.blocks[0]?.start).toBeInstanceOf(Date);
    expect(loaded?.day).toEqual(stored.day);
  });

  it("keeps Claude Code evidence after the logs are cleaned up", async () => {
    const s = await store();
    const first = await openDay(FIXTURE_DATE, config, s, { ctx: ctx(claudeDir) });
    const again = await openDay(FIXTURE_DATE, config, s, { ctx: ctx("/nonexistent") });
    expect(again.stored.day.blocks).toEqual(first.stored.day.blocks);
  });

  it("shows the corrected day instead of rebuilding it, unless asked to refresh", async () => {
    const s = await store();
    const { stored } = await openDay(FIXTURE_DATE, config, s, { ctx: ctx(claudeDir) });
    const edited = { ...stored, day: { ...stored.day, blocks: stored.day.blocks.slice(1) } };
    edited.edits = [{ at: new Date().toISOString(), ops: [{ op: "delete", id: "b1" }] }];
    await s.save(edited);
    expect((await openDay(FIXTURE_DATE, config, s, { ctx: ctx(claudeDir) })).kept).toBe(true);
    const refreshed = await openDay(FIXTURE_DATE, config, s, {
      ctx: ctx(claudeDir),
      refresh: true,
    });
    expect(refreshed.stored.day.blocks).toHaveLength(stored.day.blocks.length);
    expect(refreshed.stored.edits).toEqual([]);
  });

  it("reports a failing source and builds the day from the rest", async () => {
    const s = await store();
    const broken = fixtureConfig({
      sources: [
        { type: "claude-code" },
        { type: "calendar", method: "ics", url: "https://127.0.0.1:9/x.ics" },
      ],
    });
    const { warnings, stored } = await openDay(FIXTURE_DATE, broken, s, { ctx: ctx(claudeDir) });
    expect(warnings).toEqual([
      expect.stringMatching(/^Calendar: couldn't reach the calendar feed/),
    ]);
    expect(warnings[0]).not.toContain("127.0.0.1");
    expect(stored.day.blocks.length).toBeGreaterThan(0);
  });
});

describe("corrections and new activity", () => {
  const prompt = (hhmm: string, title: string) => ({
    source: "fake",
    kind: "prompt" as const,
    actor: "human" as const,
    start: new Date(`${FIXTURE_DATE}T${hhmm}:00+05:30`),
    repo: "acme/api",
    sessionId: title,
    title,
  });
  const fakeConfig = fixtureConfig({ sources: [{ type: "claude-code" }] });
  let feed = [prompt("10:00", "Morning")];
  const sources = () => ({
    id: "claude-code",
    name: "fake",
    detect: async () => null,
    async *collect() {
      yield* feed;
    },
  });

  it("replays your corrections on top of new activity", async () => {
    const s = await store();
    feed = [prompt("10:00", "Morning")];
    const first = await openDay(FIXTURE_DATE, fakeConfig, s, { sources });
    const { commitEdits } = await import("../../src/corrections");
    await commitEdits(
      first.stored,
      [{ op: "update", id: "b1", summary: "Fix login" }],
      fakeConfig,
      s,
    );

    feed = [prompt("10:00", "Morning"), prompt("16:00", "Afternoon")];
    const later = await openDay(FIXTURE_DATE, fakeConfig, s, { sources });
    expect(later.kept).toBe(true);
    expect(later.stored.day.blocks.map((b) => b.summary)).toEqual(["Fix login", "Afternoon"]);
    expect(later.stored.edits).toHaveLength(1);
  });

  it("keeps your corrected day and warns when new activity would shift the blocks", async () => {
    const s = await store();
    feed = [prompt("10:00", "Morning")];
    const first = await openDay(FIXTURE_DATE, fakeConfig, s, { sources });
    const { commitEdits } = await import("../../src/corrections");
    await commitEdits(
      first.stored,
      [{ op: "update", id: "b1", summary: "Fix login" }],
      fakeConfig,
      s,
    );

    feed = [prompt("08:00", "Early"), prompt("10:00", "Morning")];
    const later = await openDay(FIXTURE_DATE, fakeConfig, s, { sources });
    expect(later.stored.day.blocks.map((b) => b.summary)).toEqual(["Fix login"]);
    expect(later.warnings.join(" ")).toMatch(/can't be merged under your corrections/);
    expect(later.stale).toBe(true);

    const rebuilt = await openDay(FIXTURE_DATE, fakeConfig, s, { sources, refresh: true });
    expect(rebuilt.stale).toBeFalsy();
    expect(rebuilt.stored.edits).toEqual([]);
    expect(rebuilt.stored.day.blocks.map((b) => b.summary)).toEqual(["Early", "Morning"]);
  });
});
