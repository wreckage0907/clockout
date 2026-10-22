import { describe, expect, it } from "vitest";
import { applyEdits, describeEdits } from "../../src/core/edits";
import { rowKey, sendRowOps, timesheetRows } from "../../src/core/timesheet";
import { config, fixtureDay } from "../helpers/fake-app";

describe("sending a row to its own ERP task", () => {
  const row = fixtureDay.blocks.find((b) => b.project === "acme/api" && b.confirmed);
  if (!row) throw new Error("fixture day has no acme/api block");
  const key = rowKey(row);
  const blocksOfRow = fixtureDay.blocks.filter(
    (b) => b.confirmed && b.billable && rowKey(b) === key,
  );

  it("marks every block of the row, shows on the row, and leaves the others alone", () => {
    const ops = sendRowOps(fixtureDay, key, { task: "TASK-9", label: "Bug fixing" });
    expect(ops).toHaveLength(blocksOfRow.length);
    const { day, errors } = applyEdits(fixtureDay, ops, config);
    expect(errors).toEqual([]);
    const rows = timesheetRows(day, config);
    expect(
      rows.find((r) => r.project === "acme/api" && r.description === row.summary),
    ).toMatchObject({ sendTo: { task: "TASK-9", label: "Bug fixing" } });
    expect(rows.filter((r) => r.sendTo)).toHaveLength(1);
    expect(describeEdits(fixtureDay, ops.slice(0, 1))[0]).toContain("send to Bug fixing");
  });

  it("goes back to the project's task with null", () => {
    const sent = applyEdits(
      fixtureDay,
      sendRowOps(fixtureDay, key, { task: "TASK-9", label: "Bug fixing" }),
      config,
    ).day;
    const back = applyEdits(sent, sendRowOps(sent, key, null), config).day;
    expect(timesheetRows(back, config).some((r) => r.sendTo)).toBe(false);
  });
});
