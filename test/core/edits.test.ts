import { describe, expect, it } from "vitest";
import { buildDay } from "../../src/core/blocks";
import { editOpSchema } from "../../src/core/edit-schema";
import { applyEdits, describeEdits } from "../../src/core/edits";
import { localTime } from "../../src/core/time";
import { dayTotals } from "../../src/core/timesheet";
import type { Day, EditOp } from "../../src/core/types";
import { FIXTURE_DATE, fixtureActivities, fixtureConfig } from "../helpers/fixture-day";

const config = fixtureConfig();
const day = buildDay(FIXTURE_DATE, await fixtureActivities(), config);
const TZ = "Asia/Kolkata";

function apply(ops: EditOp[], from: Day = day) {
  for (const op of ops) editOpSchema.parse(op);
  const r = applyEdits(from, ops, config);
  expect(r.errors).toEqual([]);
  return r.day;
}
const view = (d: Day) =>
  d.blocks.map(
    (b) =>
      `${b.id} ${localTime(b.start, TZ)}-${localTime(b.end, TZ)} ${b.project}${b.confirmed ? "" : "?"}${b.billable ? "" : " (unbilled)"} ${b.summary}`,
  );

describe("applyEdits", () => {
  it("fills lunch as an unbilled break and drops its gap question", () => {
    const d = apply([{ op: "fill_gap", gapId: "g1", summary: "Lunch", billable: false }]);
    expect(view(d)).toContain("b9 12:15-14:00 Break (unbilled) Lunch");
    expect(d.questions.some((q) => q.text.includes("12:15"))).toBe(false);
    expect(dayTotals(d, config).hours).toBe(dayTotals(day, config).hours);
  });

  it("confirms a tentative meeting, which then takes its time from work", () => {
    const d = apply([{ op: "update", id: "b4", confirmed: true }]);
    expect(view(d).filter((l) => /^b(3|4|9) /.test(l))).toEqual([
      "b3 14:00-15:00 dev-example/clockout Build export command (PR #48)",
      "b4 15:00-15:30 Meetings Design sync",
      "b9 15:30-16:33 dev-example/clockout Build export command (PR #48)",
    ]);
    expect(d.questions.find((q) => q.text.includes("Design sync"))).toBeUndefined();
  });

  it("removes a skipped meeting and its question", () => {
    const d = apply([{ op: "delete", id: "b7" }]);
    expect(d.blocks.find((b) => b.id === "b7")).toBeUndefined();
    expect(d.questions.find((q) => q.text.includes("Acme weekly sync"))).toBeUndefined();
  });

  it("changes a block's length and trims what it now overlaps", () => {
    const d = apply([{ op: "update", id: "b1", end: "10:30" }]);
    expect(view(d).slice(0, 2)).toEqual([
      "b1 09:30-10:30 Meetings Daily standup",
      "b2 10:30-12:15 acme/api Fix auth token refresh (PR #87)",
    ]);
  });

  it("gives time added to a project by hand that project's own task", () => {
    const withProject = {
      ...config,
      projects: [...config.projects, { name: "Internal Tools", task: "Tooling" }],
    };
    const r = applyEdits(
      day,
      [{ op: "add", start: "17:00", end: "17:30", project: "internal tools", summary: "Fix CI" }],
      withProject,
    );
    expect(r.errors).toEqual([]);
    expect(r.day.blocks.find((b) => b.summary === "Fix CI")).toMatchObject({
      task: "Tooling",
      kind: "work",
    });
  });

  it("adds a block in a gap, splits, and merges", () => {
    const added = apply([
      {
        op: "add",
        start: "17:00",
        end: "17:30",
        project: "acme/api",
        task: "Code Review",
        summary: "Review Sam's PR",
      },
    ]);
    expect(added.blocks.find((b) => b.summary === "Review Sam's PR")).toMatchObject({
      kind: "review",
    });

    const split = apply([{ op: "split", id: "b2", at: "11:00" }]);
    expect(view(split).filter((l) => l.includes("acme/api Fix"))).toEqual([
      "b2 10:00-11:00 acme/api Fix auth token refresh (PR #87)",
      "b9 11:00-12:15 acme/api Fix auth token refresh (PR #87)",
    ]);
    const merged = apply([{ op: "merge", ids: ["b9", "b2"] }], split);
    expect(view(merged)).toContain("b2 10:00-12:15 acme/api Fix auth token refresh (PR #87)");
  });

  it("rejects the whole batch when one edit is wrong, and passes questions back", () => {
    const r = applyEdits(
      day,
      [
        { op: "delete", id: "b1" },
        { op: "update", id: "b99", summary: "x" },
        { op: "clarify", question: "Which PR?" },
      ],
      config,
    );
    expect(r.errors).toEqual(["There's no block b99."]);
    expect(r.day).toBe(day);
    expect(r.clarifications).toEqual(["Which PR?"]);
  });

  it("refuses times that end before they start", () => {
    expect(applyEdits(day, [{ op: "update", id: "b2", end: "09:00" }], config).errors).toEqual([
      "10:00–09:00 ends before it starts.",
    ]);
  });

  it("asks which project a billable gap was", () => {
    expect(
      applyEdits(day, [{ op: "fill_gap", gapId: "g1", summary: "Work" }], config).errors,
    ).toEqual(["Which project was 12:15–14:00?"]);
  });
});

describe("describeEdits", () => {
  it("previews each change in words", () => {
    expect(
      describeEdits(day, [
        { op: "fill_gap", gapId: "g1", summary: "Lunch", billable: false },
        { op: "update", id: "b2", end: "12:30" },
        { op: "update", id: "b4", confirmed: true },
        { op: "delete", id: "b7" },
      ]),
    ).toEqual([
      "Fill 12:15–14:00 (1h45) with Lunch (not billed)",
      "b2 Fix auth token refresh (PR #87): 10:00–12:15 → 10:00–12:30",
      "b4 Design sync: attended",
      "Remove b7 Acme weekly sync",
    ]);
  });
});

describe("review fixes", () => {
  it("drops leftovers under 5 minutes instead of billing them as 15", () => {
    const work = buildDay(
      "2026-10-20",
      ["09:58", "10:05", "10:12", "10:19", "10:25"].map((t) => ({
        source: "test",
        kind: "prompt" as const,
        actor: "human" as const,
        start: new Date(`2026-10-20T${t}:00+05:30`),
        repo: "acme/api",
        sessionId: "s",
        title: "Task",
      })),
      config,
    );
    const d = apply(
      [{ op: "add", start: "10:00", end: "11:00", project: "Acme", summary: "Call" }],
      work,
    );
    expect(view(d)).toEqual(["b2 10:00-11:00 Acme Call"]);
  });

  it("refuses to merge a block with itself", () => {
    expect(applyEdits(day, [{ op: "merge", ids: ["b1", "b1"] }], config).errors).toEqual([
      "Merging needs at least two different blocks.",
    ]);
  });

  it("accepts 24:00 as the end of the day", () => {
    const d = apply([{ op: "update", id: "b8", end: "24:00" }]);
    expect(d.blocks.find((b) => b.id === "b8")?.end.toISOString()).toBe("2026-10-16T18:30:00.000Z");
  });
});
