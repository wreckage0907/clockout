import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config/schema";
import { applyEdits } from "../../src/core/edits";
import { App } from "../../src/tui/App";
import { config, fakeActions, fixtureDay } from "../helpers/fake-app";
import { FIXTURE_DATE } from "../helpers/fixture-day";

const W = 120;
const H = 40;
const tick = () => new Promise((r) => setTimeout(r, 30));
const DOWN = "\u001b[B";
const PASTE = (text: string) => `\u001b[200~${text}\u001b[201~`;

async function until(frame: () => string | undefined, text: string) {
  for (let i = 0; i < 50 && !(frame() ?? "").includes(text); i++) await tick();
}

function open(opts: Parameters<typeof fakeActions>[0] = {}) {
  const fake = fakeActions(opts);
  const ui = render(
    <App
      initialDate={FIXTURE_DATE}
      today={FIXTURE_DATE}
      config={config}
      actions={fake.actions}
      width={W}
      height={H}
    />,
  );
  return { ui, ...fake };
}

async function openDay(opts: Parameters<typeof fakeActions>[0] = {}) {
  const app = open(opts);
  await until(app.ui.lastFrame, "5h 45m of 8h");
  app.ui.stdin.write("\r");
  await until(app.ui.lastFrame, "Copy sheet");
  return app;
}

async function down(ui: ReturnType<typeof render>, n: number) {
  for (let i = 0; i < n; i++) {
    ui.stdin.write(DOWN);
    await tick();
  }
}

describe("home", () => {
  it("is the logo on the hours bar, the total against the target, and the chat bar", async () => {
    const { ui, calls } = open();
    await until(ui.lastFrame, "5h 45m of 8h");
    const frame = ui.lastFrame() ?? "";
    expect(calls.loads).toEqual([FIXTURE_DATE]);
    expect(frame).toContain("Tell me about your day");
    expect(frame).toContain("Today · Fri, Oct 16 ▾");
    expect(frame).toContain("Setup");
    for (const gone of ["questions", "haiku", "commands", "untracked"])
      expect(frame).not.toContain(gone);
  });

  it("uses the daily target from the config", async () => {
    const fake = fakeActions();
    const six: Config = { ...config, day: { ...config.day, target: "6h" } };
    const ui = render(
      <App
        initialDate={FIXTURE_DATE}
        today={FIXTURE_DATE}
        config={six}
        actions={fake.actions}
        width={W}
        height={H}
      />,
    );
    await until(ui.lastFrame, "of 6h");
    expect(ui.lastFrame()).toContain("5h 45m of 6h");
  });
});

describe("day view", () => {
  it("shows one card per timesheet row with its duration, and meetings to answer", async () => {
    const { ui } = await openDay();
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Fix auth token refresh (PR #87)");
    expect(frame).toContain("2h 15m");
    expect(frame).toContain("Claude Code + GitHub · 17 prompts in 1 session · opened PR #87");
    expect(frame).toContain("Did you attend “Design sync”?");
  });

  it("typing a length into a card saves it as minutes and moves the total by the difference", async () => {
    const { ui, calls } = await openDay();
    await down(ui, 2); // Fix auth token refresh, 2h 15m
    ui.stdin.write("\r");
    await tick();
    ui.stdin.write("1h 45");
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "5h 15m of 8h");
    expect(calls.commits.at(-1)?.ops).toEqual([{ op: "update", id: "b2", minutes: 105 }]);
    expect(ui.lastFrame()).toContain("set by you");
  });

  it("+ nudges the selected card by the rounding step, and ctrl+z undoes it", async () => {
    const { ui } = await openDay();
    await down(ui, 1); // Daily standup, 30m
    ui.stdin.write("+");
    await until(ui.lastFrame, "6h of 8h");
    ui.stdin.write("\u001a"); // ctrl+z
    await until(ui.lastFrame, "5h 45m of 8h");
    expect(ui.lastFrame()).toContain("5h 45m of 8h");
  });

  it("answering a meeting saves it, without counting its overlap with coding twice", async () => {
    const { ui, calls } = await openDay();
    await down(ui, 4); // Design sync
    ui.stdin.write("\r"); // Attended
    await until(ui.lastFrame, "Attended · ctrl+z");
    expect(calls.commits.at(-1)?.ops).toEqual([{ op: "update", id: "b4", confirmed: true }]);
    expect(ui.lastFrame()).not.toContain("Did you attend “Design sync”?");
    expect(ui.lastFrame()).toContain("5h 45m of 8h");
  });

  it("won't copy while meetings are waiting", async () => {
    const { ui, calls } = await openDay();
    ui.stdin.write("\u0019"); // ctrl+y
    await until(ui.lastFrame, "Answer the 3 meetings first");
    expect(calls.copied).toEqual([]);
  });

  it("copies tab-separated rows, with the lengths you set, once nothing is waiting", async () => {
    const skipped = applyEdits(
      fixtureDay,
      ["b4", "b6", "b7"].map((id) => ({ op: "delete" as const, id })),
      config,
    ).day;
    const { ui, calls } = await openDay({ day: skipped });
    await down(ui, 1); // Daily standup
    ui.stdin.write("+");
    await until(ui.lastFrame, "6h of 8h");
    ui.stdin.write("\u001b"); // deselect: Enter on nothing copies
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Copied");
    const lines = calls.copied[0]?.split("\n") ?? [];
    // Paste-ready rows, no header; the standup counts the 45 minutes you set.
    expect(lines[0]).toBe("2026-10-16\tMeetings\tMeetings\t0.75\tDaily standup");
    expect(lines).toHaveLength(5);
  });

  it("sends a sentence to the AI, shows the proposal, and applies it with Enter", async () => {
    const { ui, calls } = await openDay({
      parse: async () => ({
        ops: [{ op: "update", id: "b1", minutes: 45 }],
        reply: "Standup ran to 45 minutes.",
      }),
    });
    ui.stdin.write(PASTE("standup ran to 45 minutes\n"));
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Apply");
    expect(ui.lastFrame()).toContain("Standup ran to 45 minutes.");
    expect(calls.commits).toEqual([]);
    ui.stdin.write("\r");
    await until(ui.lastFrame, "6h of 8h");
    expect(calls.commits.at(-1)).toEqual({
      ops: [{ op: "update", id: "b1", minutes: 45 }],
      text: "standup ran to 45 minutes",
    });
  });

  it("without an AI helper, a sentence stays in the bar with a pointer to setup", async () => {
    const { ui, calls } = await openDay();
    ui.stdin.write("lunch was long");
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Turn it on in Setup");
    expect(ui.lastFrame()).toContain("lunch was long");
    expect(calls.commits).toEqual([]);
  });

  it("adds untracked time from the dashed card", async () => {
    const { ui, calls } = await openDay();
    await down(ui, 9); // past the last card: + Add time
    ui.stdin.write("\r");
    await until(ui.lastFrame, "How long");
    ui.stdin.write("\r"); // 1h on the first project
    await until(ui.lastFrame, "6h 45m of 8h");
    expect(calls.commits.at(-1)?.ops[0]).toMatchObject({ op: "add", start: "12:15", end: "13:15" });
  });
});

describe("setup", () => {
  it("ctrl+p opens it over the screen with tickable sources, and esc closes it", async () => {
    const { ui } = open();
    await until(ui.lastFrame, "5h 45m of 8h");
    ui.stdin.write("\u0010");
    await until(ui.lastFrame, "Tick what Clockout reads");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Google Calendar");
    expect(frame).toContain("tick to sign in");
    expect(frame).toContain("coming soon");
    ui.stdin.write("\u001b");
    await tick();
    expect(ui.lastFrame()).not.toContain("Tick what Clockout reads");
  });
});
