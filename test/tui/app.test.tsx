import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config/schema";
import { applyEdits } from "../../src/core/edits";
import { parseDuration } from "../../src/core/time";
import { App } from "../../src/tui/App";
import { config, fakeActions, fixtureDay } from "../helpers/fake-app";
import { fakeTarget } from "../helpers/fake-target";
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
  await until(app.ui.lastFrame, "6h of 8h");
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
    await until(ui.lastFrame, "6h of 8h");
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
    expect(ui.lastFrame()).toContain("6h of 6h");
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
    await until(ui.lastFrame, "5h 30m of 8h");
    expect(calls.commits.at(-1)?.ops).toEqual([{ op: "update", id: "b2", minutes: 105 }]);
    expect(ui.lastFrame()).toContain("set by you");
  });

  it("ctrl+d removes the selected card from the day, and ctrl+z brings it back", async () => {
    const { ui, calls } = await openDay();
    await down(ui, 2); // Fix auth token refresh, 2h 15m
    ui.stdin.write("\u0004"); // ctrl+d
    await until(ui.lastFrame, "3h 45m of 8h");
    expect(calls.commits.at(-1)?.ops).toEqual([{ op: "delete", id: "b2" }]);
    expect(ui.lastFrame()).toContain("Removed “Fix auth token refresh (PR #87)” · day 3h 45m");
    expect(ui.lastFrame()).not.toContain("17 prompts in 1 session");
    ui.stdin.write("\u001a"); // ctrl+z
    await until(ui.lastFrame, "6h of 8h");
    expect(ui.lastFrame()).toContain("17 prompts in 1 session");
  });

  it("+ nudges the selected card by the rounding step, and ctrl+z undoes it", async () => {
    const { ui } = await openDay();
    await down(ui, 1); // Daily standup, 30m
    ui.stdin.write("+");
    await until(ui.lastFrame, "6h 15m of 8h");
    ui.stdin.write("\u001a"); // ctrl+z
    await until(ui.lastFrame, "6h of 8h");
    expect(ui.lastFrame()).toContain("6h of 8h");
  });

  it("answering a meeting saves it, without counting its overlap with coding twice", async () => {
    const { ui, calls } = await openDay();
    await down(ui, 4); // Design sync
    ui.stdin.write("\r"); // Attended
    await until(ui.lastFrame, "Attended · ctrl+z");
    expect(calls.commits.at(-1)?.ops).toEqual([{ op: "update", id: "b4", confirmed: true }]);
    expect(ui.lastFrame()).not.toContain("Did you attend “Design sync”?");
    expect(ui.lastFrame()).toContain("6h of 8h");
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
    await until(ui.lastFrame, "6h 15m of 8h");
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
    await until(ui.lastFrame, "6h 15m of 8h");
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

  it("adds untracked time from the dashed card, which counts down to the daily target", async () => {
    const { ui, calls } = await openDay();
    await down(ui, 9); // past the last card: + Add time
    const frame = ui.lastFrame() ?? "";
    const total = parseDuration(/(\S+) of 8h/.exec(frame)?.[1] ?? "") ?? 0;
    const left = parseDuration(/([\dhm ]+) short of your 8h day/.exec(frame)?.[1]?.trim() ?? "");
    expect(left).toBe(480 - total); // the target, not the gaps in working hours
    ui.stdin.write("\r");
    await until(ui.lastFrame, "How long");
    ui.stdin.write("\r"); // 1h on the first project
    await until(ui.lastFrame, "6h 45m of 8h");
    expect(calls.commits.at(-1)?.ops[0]).toMatchObject({ op: "add", start: "12:15", end: "13:15" });
  });
});

describe("setup from the chat bar", () => {
  it("proposes a settings change, saves it on Enter, and drafts the day again", async () => {
    const { ui, calls } = await openDay({
      parse: async () => ({
        ops: [],
        settings: [{ op: "day", target: "7h" }],
        reply: "Your target is 7h now.",
      }),
    });
    ui.stdin.write(PASTE("my target is seven hours"));
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Apply");
    expect(ui.lastFrame()).toContain("daily target → 7h");
    expect(calls.configured).toEqual([]);
    ui.stdin.write("\r");
    await until(ui.lastFrame, "of 7h");
    expect(calls.configured).toEqual([[{ op: "day", target: "7h" }]]);
    expect(ui.lastFrame()).toContain("✓ Your target is 7h now.");
    expect(calls.commits).toEqual([]);
    for (let i = 0; i < 50 && calls.loads.length < 2; i++) await tick();
    expect(calls.loads).toHaveLength(2);
  });

  it("connects the ERP from a plain sentence, even without the AI", async () => {
    const { ui, calls } = await openDay();
    ui.stdin.write(PASTE("connect erp erp.example.com"));
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Apply");
    expect(ui.lastFrame()).toContain("Sign in to your ERP at erp.example.com in your browser");
    ui.stdin.write("\r");
    await until(ui.lastFrame, "✓ Connect your ERP");
    expect(calls.configured).toEqual([[{ op: "connect", service: "erp", url: "erp.example.com" }]]);
    expect(calls.loads).toHaveLength(1); // the ERP doesn't change the draft
  });

  it("passes the last turns along, so a follow-up answers the AI's question", async () => {
    const seen: unknown[] = [];
    const { ui } = await openDay({
      parse: async (_t, _d, earlier) => {
        seen.push(earlier);
        return { ops: [{ op: "clarify", question: "Which project?" }], reply: "" };
      },
    });
    for (const said of ["leave out that project", "the personal one"]) {
      ui.stdin.write(PASTE(said));
      await tick();
      ui.stdin.write("\r");
      await until(ui.lastFrame, "Which project?");
      for (let i = 0; i < 80 && (ui.lastFrame() ?? "").includes("Thinking"); i++) await tick();
    }
    expect(seen).toEqual([
      [],
      [{ said: "leave out that project", reply: "Question: Which project?" }],
    ]);
  });

  it("rebuilds the day when you say refresh, asking first because it drops corrections", async () => {
    const { ui, calls } = await openDay({ stale: true });
    expect(ui.lastFrame()).toContain("can't be merged under your corrections");
    expect(ui.lastFrame()).toContain("Rebuild the day");
    ui.stdin.write(PASTE("refresh"));
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Drops your 1 correction");
    expect(calls.refreshes).toBe(0);
    ui.stdin.write("\r");
    for (let i = 0; i < 50 && (ui.lastFrame() ?? "").includes("can't be merged"); i++) await tick();
    expect(calls.refreshes).toBe(1);
    expect(ui.lastFrame()).not.toContain("can't be merged");
  });

  it("drafts the day again straight away on refresh when there's nothing to lose", async () => {
    const { ui, calls } = await openDay();
    ui.stdin.write(PASTE("refresh the day"));
    await tick();
    ui.stdin.write("\r");
    for (let i = 0; i < 50 && calls.refreshes === 0; i++) await tick();
    expect(calls.refreshes).toBe(1);
    expect(calls.loads).toEqual([FIXTURE_DATE, FIXTURE_DATE]);
  });

  it("opens the ERP task picker on the words you used when the search isn't conclusive", async () => {
    const erp = fakeTarget({
      tasks: [
        { id: "TASK-H1", subject: "Hackathon build", project: "Clockout" },
        { id: "TASK-H2", subject: "Hackathon demo", project: "Clockout" },
      ],
    });
    const { ui, calls } = await openDay({
      erp: { target: erp.target },
      parse: async () => ({
        ops: [],
        settings: [{ op: "erp_task", project: "acme/api", search: "hackathon" }],
        reply: "",
      }),
    });
    ui.stdin.write(PASTE("send acme api to the hackathon task"));
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Apply");
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Which ERP task is this?");
    await until(ui.lastFrame, "Hackathon demo");
    expect(ui.lastFrame()).toContain("hackathon");
    ui.stdin.write(DOWN);
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "goes to Hackathon demo");
    expect(calls.mapped).toEqual([
      { project: "acme/api", erp_task: "TASK-H2", label: "Hackathon demo" },
    ]);
    expect(ui.lastFrame()).not.toContain("Send to erp.example.com");
  });
});

describe("setup", () => {
  it("ctrl+p opens it over the screen with tickable sources, and esc closes it", async () => {
    const { ui } = open();
    await until(ui.lastFrame, "6h of 8h");
    ui.stdin.write("\u0010");
    await until(ui.lastFrame, "Tick what Clockout reads");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Google Calendar");
    expect(frame).toContain("tick to sign in");
    expect(frame).toContain("Pi");
    expect(frame).toContain("no sessions found"); // Codex isn't on this machine
    ui.stdin.write("\u001b");
    await tick();
    expect(ui.lastFrame()).not.toContain("Tick what Clockout reads");
  });
});
