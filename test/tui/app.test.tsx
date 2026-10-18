import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import type { Correction } from "../../src/ai/edits";
import { buildDay } from "../../src/core/blocks";
import { applyEdits } from "../../src/core/edits";
import type { Day } from "../../src/core/types";
import type { StoredDay } from "../../src/store/json-store";
import { App, type AppActions } from "../../src/tui/App";
import { FIXTURE_DATE, fixtureActivities, fixtureConfig } from "../helpers/fixture-day";

const config = fixtureConfig();
const activities = await fixtureActivities();
const stored: StoredDay = {
  version: 1,
  date: FIXTURE_DATE,
  collectedAt: "2026-10-16T19:00:00Z",
  activities,
  day: buildDay(FIXTURE_DATE, activities, config),
  history: [],
  edits: [],
  summaryCache: {},
};

function setup(parse: (text: string, day: Day) => Promise<Correction>) {
  const copied: string[] = [];
  const actions: AppActions = {
    load: async () => ({ stored, warnings: [], kept: false }),
    parse,
    commit: async (s, ops, text) => {
      const r = applyEdits(s.day, ops, config);
      return {
        stored: { ...s, day: r.day, history: [s.day], edits: [{ at: "", text, ops }] },
        errors: r.errors,
      };
    },
    undo: async (s) =>
      s.history.length ? { ...s, day: s.history[0] as Day, history: [], edits: [] } : null,
    copy: async (t) => {
      copied.push(t);
    },
  };
  const ui = render(
    <App initialDate={FIXTURE_DATE} config={config} actions={actions} aiLabel="Fake AI" />,
  );
  return { ui, copied };
}

const tick = () => new Promise((r) => setTimeout(r, 30));
const PASTE = (text: string) => `\u001b[200~${text}\u001b[201~`;

describe("review screen", () => {
  it("shows the drafted day, questions and evidence", async () => {
    const { ui } = setup(async () => ({ ops: [], reply: "" }));
    await tick();
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("clockout");
    expect(frame).toContain("5.75h");
    expect(frame).toContain("Daily standup");
    expect(frame).toContain("Fix auth token refresh (PR #87)");
    expect(frame).toContain("── gap ──");
    expect(frame).toContain("Questions");
    expect(frame).toContain("Did you attend");
    ui.unmount();
  });

  it("takes a dictated paste as one input, proposes the change, and applies it on y", async () => {
    const parse = vi.fn(async () => ({
      ops: [{ op: "delete" as const, id: "b4" }],
      reply: "Removed the design sync.",
    }));
    const { ui } = setup(parse);
    await tick();
    ui.stdin.write(PASTE("I skipped the\ndesign sync"));
    await tick();
    expect(ui.lastFrame()).toContain("I skipped the design sync");
    expect(parse).not.toHaveBeenCalled(); // a newline in a paste never submits
    ui.stdin.write("\r");
    await tick();
    expect(parse).toHaveBeenCalledWith("I skipped the design sync", expect.anything());
    expect(ui.lastFrame()).toContain("Proposed changes");
    expect(ui.lastFrame()).toContain("Remove b4 Design sync");
    ui.stdin.write("y");
    await tick();
    expect(ui.lastFrame()).toContain("Saved. Removed the design sync.");
    expect(ui.lastFrame()).not.toContain("Design sync");
    ui.unmount();
  });

  it("copies the timesheet as tab-separated rows on Ctrl+Y, and types letters normally", async () => {
    const { ui, copied } = setup(async () => ({ ops: [], reply: "" }));
    await tick();
    ui.stdin.write("c");
    await tick();
    expect(copied).toEqual([]);
    expect(ui.lastFrame()).toContain("› c");
    ui.stdin.write("\u001b"); // Esc clears
    ui.stdin.write("\u0019"); // Ctrl+Y
    await tick();
    expect(copied[0]?.split("\n")).toHaveLength(5);
    expect(copied[0]).toContain("2026-10-16\tacme/api\tDevelopment\t2.25\t");
    expect(ui.lastFrame()).toContain("Copied 5 rows");
    ui.unmount();
  });
});
