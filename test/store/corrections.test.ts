import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildDay } from "../../src/core/blocks";
import { commitEdits, undoEdit } from "../../src/corrections";
import { DayStore, type StoredDay } from "../../src/store/json-store";
import { FIXTURE_DATE, fixtureActivities, fixtureConfig } from "../helpers/fixture-day";

const config = fixtureConfig();

async function setup() {
  const store = new DayStore(await mkdtemp(join(tmpdir(), "clockout-edits-")));
  const activities = await fixtureActivities();
  const stored: StoredDay = {
    version: 1,
    date: FIXTURE_DATE,
    collectedAt: new Date().toISOString(),
    activities,
    day: buildDay(FIXTURE_DATE, activities, config),
    history: [],
    edits: [],
    summaryCache: {},
  };
  await store.save(stored);
  return { store, stored };
}

describe("commitEdits and undoEdit", () => {
  it("saves the edited day with the sentence and an undo point", async () => {
    const { store, stored } = await setup();
    const r = await commitEdits(
      stored,
      [{ op: "delete", id: "b7" }],
      config,
      store,
      "skipped the Acme sync",
    );
    const saved = await store.load(FIXTURE_DATE);
    expect(saved?.day.blocks.map((b) => b.id)).not.toContain("b7");
    expect(saved?.edits).toEqual([
      { at: expect.any(String), text: "skipped the Acme sync", ops: [{ op: "delete", id: "b7" }] },
    ]);
    expect(saved?.history).toHaveLength(1);

    const undone = await undoEdit(r.stored, store);
    expect(undone?.day.blocks.map((b) => b.id)).toContain("b7");
    expect((await store.load(FIXTURE_DATE))?.edits).toEqual([]);
  });

  it("saves nothing when an edit is invalid or there's only a question", async () => {
    const { store, stored } = await setup();
    const bad = await commitEdits(stored, [{ op: "delete", id: "b99" }], config, store);
    expect(bad.errors).toHaveLength(1);
    const asked = await commitEdits(
      stored,
      [{ op: "clarify", question: "Which day?" }],
      config,
      store,
    );
    expect(asked.clarifications).toEqual(["Which day?"]);
    expect((await store.load(FIXTURE_DATE))?.history).toEqual([]);
  });

  it("has nothing to undo on a fresh day", async () => {
    const { store, stored } = await setup();
    expect(await undoEdit(stored, store)).toBeNull();
  });
});
