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
