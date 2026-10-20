import { describe, expect, it } from "vitest";
import { applyEdits, describeEdits, placeTimeOps } from "../../src/core/edits";
import { blockHours, rowKey, setRowMinutesOps, timesheetRows } from "../../src/core/timesheet";
import { config, fixtureDay as day } from "../helpers/fake-app";

const apply = (ops: Parameters<typeof applyEdits>[1], on = day) => {
  const r = applyEdits(on, ops, config);
  expect(r.errors).toEqual([]);
  return r.day;
};
const hours = (d: typeof day, description: string) =>
  timesheetRows(d, config).find((r) => r.description === description)?.hours;

describe("lengths you set", () => {
  it("replace a block's times on the timesheet, exactly, without moving its times", () => {
    const b1 = day.blocks.find((b) => b.id === "b1");
    const after = apply([{ op: "update", id: "b1", minutes: 50 }]);
    const set = after.blocks.find((b) => b.id === "b1");
    expect(set?.minutes).toBe(50);
    expect([set?.start, set?.end]).toEqual([b1?.start, b1?.end]);
    expect(hours(after, "Daily standup")).toBeCloseTo(50 / 60); // not rounded to 0.75
    if (set) expect(blockHours(set, config)).toBeCloseTo(50 / 60);
  });

  it("are described in the proposed change", () => {
    expect(describeEdits(day, [{ op: "update", id: "b1", minutes: 45 }])).toEqual([
      "b1 Daily standup: length → 0h45",
    ]);
  });

  it("set a whole row: the first block carries it, the rest count zero", () => {
    const b2 = day.blocks.find((b) => b.id === "b2");
    if (!b2) throw new Error("fixture day changed");
    const ops = setRowMinutesOps(day, rowKey(b2), 90);
    expect(ops).toEqual([{ op: "update", id: "b2", minutes: 90 }]);
    expect(hours(apply(ops), "Fix auth token refresh (PR #87)")).toBe(1.5);
  });

  it("carry over a merge as the sum of what each part counted", () => {
    const set = apply([{ op: "update", id: "b2", minutes: 60 }]);
    const merged = apply([{ op: "merge", ids: ["b2", "b5"] }], set);
    const b5 = day.blocks.find((b) => b.id === "b5");
    const b5Minutes = b5 ? (b5.end.getTime() - b5.start.getTime()) / 60_000 : 0;
    expect(merged.blocks.find((b) => b.id === "b2")?.minutes).toBe(60 + b5Minutes);
  });

  it("are dropped by a split, which goes back to each half's times", () => {
    const set = apply([{ op: "update", id: "b2", minutes: 60 }]);
    const split = apply([{ op: "split", id: "b2", at: "11:00" }], set);
    expect(split.blocks.filter((b) => b.minutes !== undefined)).toEqual([]);
  });

  it("count once when a meeting lands in the middle of the block", () => {
    const set = apply([{ op: "update", id: "b3", minutes: 120 }]);
    const after = apply([{ op: "update", id: "b4", confirmed: true }], set); // Design sync, inside b3
    const pieces = after.blocks.filter((b) => b.summary === "Build export command (PR #48)");
    expect(pieces).toHaveLength(2);
    expect(pieces.filter((b) => b.minutes !== undefined).map((b) => b.minutes)).toEqual([120]);
  });
});

describe("placing time without a clock time", () => {
  it("uses the first untracked stretch long enough", () => {
    expect(placeTimeOps(day, "Acme API", 60, "Pairing")).toEqual([
      { op: "add", start: "12:15", end: "13:15", project: "Acme API", summary: "Pairing" },
    ]);
  });

  it("goes after the last thing you did when nothing fits", () => {
    expect(placeTimeOps(day, "Acme API", 5 * 60, "")[0]).toMatchObject({
      start: "23:46",
      end: "24:00",
      summary: "Work on Acme API",
    });
  });
});
