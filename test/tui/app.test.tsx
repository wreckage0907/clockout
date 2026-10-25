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

function open(opts: Parameters<typeof fakeActions>[0] = {}, cfg: Config = config) {
  const fake = fakeActions(opts);
  const ui = render(
    <App
      initialDate={FIXTURE_DATE}
      today={FIXTURE_DATE}
      config={cfg}
      actions={fake.actions}
      width={W}
      height={H}
    />,
  );
  return { ui, ...fake };
}

async function openDay(opts: Parameters<typeof fakeActions>[0] = {}, cfg: Config = config) {
  const app = open(opts, cfg);
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

  it("clears the old day's total while another day is drafting", async () => {
    const fake = fakeActions();
    const load = fake.actions.load;
    let release = () => {};
    fake.actions.load = (date, opts) => {
      if (date === FIXTURE_DATE) return load(date, opts);
      return new Promise((resolve, reject) => {
        release = () => void load(date, opts).then(resolve, reject);
      });
    };
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
    await until(ui.lastFrame, "6h of 8h");
    ui.stdin.write(PASTE("/date monday"));
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Drafting Mon, Oct 12");
    expect(ui.lastFrame()).not.toContain("6h of 8h");
    expect(ui.lastFrame()).not.toContain("0m of 8h");
    release();
    await until(ui.lastFrame, "6h of 8h");
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

  it("Space checks cards; ctrl+y copies them and ctrl+d removes them together", async () => {
    const { ui, calls } = await openDay();
    await down(ui, 1); // Daily standup
    ui.stdin.write(" ");
    await until(ui.lastFrame, "1 selected");
    await down(ui, 1); // Fix auth token refresh
    ui.stdin.write(" ");
    await until(ui.lastFrame, "2 selected");
    ui.stdin.write("\u0019"); // ctrl+y
    await until(ui.lastFrame, "Copied 2 selected rows");
    expect(calls.copied[0]?.split("\n")).toHaveLength(2);

    ui.stdin.write("\u0004"); // ctrl+d
    await until(ui.lastFrame, "3h 15m of 8h");
    expect(calls.commits.at(-1)?.ops).toEqual([
      { op: "delete", id: "b1" },
      { op: "delete", id: "b2" },
    ]);
    ui.stdin.write("\u001a"); // one undo restores the whole selection's removal
    await until(ui.lastFrame, "6h of 8h");
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

  it("keeps the note about a change inside the cards' column", async () => {
    const { ui } = await openDay();
    await down(ui, 1);
    ui.stdin.write("+");
    await until(ui.lastFrame, "ctrl+z undoes");
    const lines = (ui.lastFrame() ?? "").split("\n");
    const end = (text: string) => lines.find((l) => l.includes(text))?.trimEnd().length;
    // The note's text stops at its right padding (2) where the header's total ends.
    expect((end("ctrl+z undoes") ?? 0) + 2).toBe(end("6h 15m of 8h"));
  });

  it("− stops at one step instead of marking the card as set by you", async () => {
    const { ui, calls } = await openDay();
    await down(ui, 8); // Investigate flaky deploy, 15m
    await until(ui.lastFrame, "How long was “Investigate flaky deploy”?");
    ui.stdin.write("-");
    await tick();
    expect(calls.commits).toEqual([]);
    expect(ui.lastFrame()).not.toContain("set by you");
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

  it("copies while meetings are waiting, leaving them out and saying so", async () => {
    const { ui, calls } = await openDay();
    ui.stdin.write("\u0019"); // ctrl+y
    await until(ui.lastFrame, "3 meetings unanswered, left out");
    expect(calls.copied).toHaveLength(1);
    expect(calls.copied[0]).not.toContain("Design sync");
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

  it("copies as your default export with ctrl+y, and as another one with /copy <name>", async () => {
    const withExports: Config = {
      ...config,
      exports: [
        {
          name: "slack",
          type: "text",
          merge: true,
          line: "{project}: {description} ({hours})",
          columns: [{ field: "hours", format: "hm" }],
          default: true,
        },
        {
          name: "harvest",
          type: "csv",
          merge: true,
          columns: [
            { field: "date", header: "Date", format: "dd/MM/yyyy" },
            { field: "hours", header: "Time", format: "h:mm" },
          ],
        },
      ],
    };
    const { ui, calls } = await openDay({}, withExports);
    ui.stdin.write("\u0019"); // ctrl+y
    await until(ui.lastFrame, "as slack");
    expect(calls.copied[0]?.split("\n")[0]).toBe("Meetings: Daily standup (30m)");
    expect(calls.copied[0]).not.toMatch(/\n$/);
    ui.stdin.write("/copy harvest");
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "as harvest");
    expect(calls.copied[1]?.split("\r\n").slice(0, 2)).toEqual(["Date,Time", "16/10/2026,0:30"]);
    ui.stdin.write("/copy jira");
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Copy as slack");
    expect(ui.lastFrame()).toContain("Copy as slack, harvest, md or csv");
    expect(calls.copied).toHaveLength(2);
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
    const noAi =
      "The AI helper is off, so typed corrections don't work. Turn it on in Setup (ctrl+p).";
    const { ui, calls } = await openDay({ noAi });
    await until(ui.lastFrame, "No AI helper: type / for commands");
    ui.stdin.write("lunch was long");
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Turn it on in Setup");
    expect(ui.lastFrame()).toContain("lunch was long");
    expect(calls.commits).toEqual([]);
  });

  it("says at the start that there's no AI helper, and why", async () => {
    const noAi = "No AI helper found (Claude Code, Codex, opencode or Pi).";
    const { ui } = open({ noAi });
    await until(ui.lastFrame, "No AI helper found");
    expect(ui.lastFrame()).toContain("No AI helper: Enter opens the day, / lists commands");
  });

  it("shows what went wrong in full, with the fix, from the warning or /problems", async () => {
    const warnings = [
      "GitHub: the GitHub CLI isn't logged in. Run `gh auth login`.",
      "Google Calendar: the Google Calendar API is off for your Cloud project. Turn it on at https://console.cloud.google.com/apis/library/calendar-json.googleapis.com, then try again.",
    ];
    const { ui } = await openDay({ warnings });
    await until(ui.lastFrame, "2 problems");
    ui.stdin.write("/problems");
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Full details");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("Run `gh auth login`.");
    expect(frame).toContain("calendar-json.googleapis.com");
    expect(frame).toContain("~/.local/share/clockout/errors.log");
    ui.stdin.write("\u001b");
    await tick();
    expect(ui.lastFrame()).not.toContain("Full details");
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

  async function openAddTime(opts: Parameters<typeof fakeActions>[0] = {}) {
    const app = await openDay(opts);
    app.ui.stdin.write("/add");
    await tick();
    app.ui.stdin.write("\r");
    await until(app.ui.lastFrame, "How long");
    return app;
  }

  it("adds time to a project typed in, and keeps that project for other days", async () => {
    const { ui, calls } = await openAddTime();
    // Tab through the projects to "+ New project", which asks for a name.
    for (let i = 0; i < 12 && !(ui.lastFrame() ?? "").includes("enter uses it"); i++) {
      ui.stdin.write("\t");
      await tick();
    }
    ui.stdin.write("Internal Tools");
    await tick();
    ui.stdin.write("\r"); // use the name
    await until(ui.lastFrame, "Internal Tools (new)");
    ui.stdin.write("Fix the CI cache");
    await tick();
    ui.stdin.write("\r"); // add
    await until(ui.lastFrame, "Added 1h to Internal Tools");
    expect(calls.commits.at(-1)?.ops[0]).toMatchObject({
      op: "add",
      project: "Internal Tools",
      summary: "Fix the CI cache",
    });
    await until(() => JSON.stringify(calls.saved.at(-1) ?? ""), "Internal Tools");
    expect((calls.saved.at(-1) as Config).projects).toContainEqual({ name: "Internal Tools" });
  });

  it("asks for a project's name straight away when there's none to pick", async () => {
    const empty = { ...fixtureDay, blocks: [], gaps: [], questions: [] };
    const { ui } = await openAddTime({ day: empty });
    expect(ui.lastFrame()).toContain("enter uses it");
  });

  it("offers projects from other days and from the ERP, after the day's own", async () => {
    const { ui } = await openAddTime({
      more: { recent: ["Acme Website", "acme/api"], erp: ["Acme Internal", "Acme Website"] },
      erp: { target: fakeTarget().target },
    });
    await until(ui.lastFrame, "Acme Internal");
    const frame = ui.lastFrame() ?? "";
    expect(frame.indexOf("acme/api")).toBeLessThan(frame.indexOf("Acme Website"));
    expect(frame).toContain("From erp.example.com");
    expect(frame.match(/Acme Website/g)).toHaveLength(1); // once, not again under the ERP's
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

describe("slash commands", () => {
  const UP = "\u001b[A";
  const TAB = "\t";

  it("/ opens a menu of every command, narrowed as you type, and esc clears it", async () => {
    const { ui } = await openDay();
    ui.stdin.write("/");
    await until(ui.lastFrame, "tab fills in");
    let frame = ui.lastFrame() ?? "";
    for (const c of ["/refresh", "/connect", "/send", "/copy", "/setup", "/help"])
      expect(frame).toContain(c);
    ui.stdin.write("co");
    await tick();
    frame = ui.lastFrame() ?? "";
    expect(frame).toContain("/connect");
    expect(frame).toContain("/copy");
    expect(frame).not.toContain("/refresh");
    ui.stdin.write("\u001b");
    await tick();
    expect(ui.lastFrame()).not.toContain("tab fills in");
  });

  it("↑↓ choose in the menu instead of moving between cards, and enter runs the choice", async () => {
    const { ui, calls } = await openDay();
    ui.stdin.write("/co");
    await tick();
    ui.stdin.write(DOWN); // connect → copy
    await tick();
    ui.stdin.write(UP);
    await tick();
    ui.stdin.write(DOWN);
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Copied");
    expect(calls.copied).toHaveLength(1);
  });

  it("tab fills in a command that needs more words, then enter runs it", async () => {
    const { ui, calls } = await openDay();
    ui.stdin.write("/conn");
    await tick();
    ui.stdin.write(TAB);
    await tick();
    expect(ui.lastFrame()).toContain("/connect ");
    ui.stdin.write("erp erp.example.com");
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "✓ Signed in to your ERP");
    expect(ui.lastFrame()).toContain("✓ Signed in to your ERP");
    expect(calls.configured).toEqual([[{ op: "connect", service: "erp", url: "erp.example.com" }]]);
  });

  it("never sends a slash to the AI: an unknown command stays in the bar", async () => {
    const said: string[] = [];
    const { ui } = await openDay({
      parse: async (t) => {
        said.push(t);
        return { ops: [], reply: "" };
      },
    });
    ui.stdin.write(PASTE("/frobnicate the day"));
    await tick();
    expect(ui.lastFrame()).toContain("No command /frobnicate");
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Type / to see them");
    expect(ui.lastFrame()).toContain("Type / to see them");
    expect(said).toEqual([]);
    expect(ui.lastFrame()).toContain("/frobnicate the day");
  });

  it("/refresh and a dictated “slash refresh” draft the day again", async () => {
    const { ui, calls } = await openDay();
    ui.stdin.write(PASTE("Slash refresh."));
    await tick();
    ui.stdin.write("\r");
    for (let i = 0; i < 50 && calls.refreshes === 0; i++) await tick();
    expect(calls.refreshes).toBe(1);
  });

  it("/date moves to another day and /today comes back, from home too", async () => {
    const { ui, calls } = open();
    await until(ui.lastFrame, "6h of 8h");
    ui.stdin.write(PASTE("/date monday"));
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Mon, Oct 12");
    expect(ui.lastFrame()).toContain("Mon, Oct 12");
    expect(ui.lastFrame()).toContain("Tell me about your day"); // still home
    ui.stdin.write(PASTE("/today"));
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Today · Fri, Oct 16");
    expect(ui.lastFrame()).toContain("Today · Fri, Oct 16");
    expect(calls.loads).toEqual([FIXTURE_DATE, "2026-10-12", FIXTURE_DATE]);
  });

  it("/setup opens setup at the section you name", async () => {
    const { ui } = open();
    await until(ui.lastFrame, "6h of 8h");
    ui.stdin.write(PASTE("/setup day"));
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "How the day is counted");
    expect(ui.lastFrame()).toContain("How the day is counted");
  });

  it("/send without an ERP says how to sign in", async () => {
    const { ui } = await openDay();
    ui.stdin.write(PASTE("/send"));
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "/connect erp <address>");
    expect(ui.lastFrame()).toContain("/connect erp <address>");
  });

  it("/disconnect asks first, like saying it", async () => {
    const { ui, calls } = await openDay();
    ui.stdin.write(PASTE("/disconnect google"));
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Apply");
    expect(ui.lastFrame()).toContain("Sign out of Google Calendar");
    expect(calls.configured).toEqual([]);
    ui.stdin.write("\r");
    for (let i = 0; i < 50 && calls.configured.length === 0; i++) await tick();
    expect(calls.configured).toEqual([[{ op: "disconnect", service: "google" }]]);
  });

  it("/help shows the menu", async () => {
    const { ui } = await openDay();
    ui.stdin.write(PASTE("/help"));
    await tick();
    ui.stdin.write("\r");
    await tick();
    expect(ui.lastFrame()).toContain("/refresh");
    expect(ui.lastFrame()).toContain("tab fills in");
  });
});

describe("setup", () => {
  const RIGHT = "\u001b[C";
  const LEFT = "\u001b[D";
  const ESC = "\u001b";

  async function openSetup(opts: Parameters<typeof fakeActions>[0] = {}) {
    const app = open(opts);
    await until(app.ui.lastFrame, "6h of 8h");
    app.ui.stdin.write("\u0010"); // ctrl+p
    await until(app.ui.lastFrame, "What Clockout reads");
    return app;
  }
  const lastSaved = (calls: { saved: unknown[] }) => calls.saved.at(-1) as Config | undefined;

  it("ctrl+p opens it on the sources, every coding agent listed, and esc closes it", async () => {
    const { ui, calls } = await openSetup();
    const frame = ui.lastFrame() ?? "";
    for (const section of ["Sources", "Day", "AI helper", "Projects", "ERP"])
      expect(frame).toContain(section);
    expect(frame).toContain("2 of 2 projects");
    expect(frame).toContain("2 projects in ~/.pi/agent/sessions");
    expect(frame).toMatch(/Codex\s+no sessions found/);
    expect(frame).toContain("tick to sign in");
    ui.stdin.write(ESC);
    await tick();
    expect(ui.lastFrame()).not.toContain("What Clockout reads");
    expect(calls.loads).toEqual([FIXTURE_DATE]);
  });

  it("closing after a change doesn't draft the current day again", async () => {
    const { ui, calls } = await openSetup();
    ui.stdin.write(RIGHT);
    await tick();
    ui.stdin.write(" "); // turn Claude Code off
    for (let i = 0; i < 50 && calls.saved.length === 0; i++) await tick();
    expect(calls.saved).toHaveLength(1);
    ui.stdin.write("\u0010"); // ctrl+p closes from the rows too
    await tick();
    expect(ui.lastFrame()).not.toContain("What Clockout reads");
    expect(calls.loads).toEqual([FIXTURE_DATE]);
  });

  it("ticks a source from the keyboard, skipping one that isn't on this machine", async () => {
    const { ui, calls } = await openSetup();
    ui.stdin.write(RIGHT); // into the rows: Claude Code
    await tick();
    await down(ui, 1); // Pi
    ui.stdin.write(" ");
    await until(ui.lastFrame, "✓ Pi");
    expect(lastSaved(calls)?.sources.map((s) => s.type)).toContain("pi");
    await down(ui, 1); // Codex has no sessions, so this lands on Google Calendar
    ui.stdin.write(" ");
    await until(ui.lastFrame, "meetings you kept");
    expect(lastSaved(calls)?.sources.map((s) => s.type)).toContain("google-calendar");
    expect(lastSaved(calls)?.sources.map((s) => s.type)).not.toContain("codex");
  });

  it("changes the day's numbers with the arrow keys", async () => {
    const { ui, calls } = await openSetup();
    await down(ui, 1); // Day
    await until(ui.lastFrame, "How the day is counted");
    ui.stdin.write(RIGHT); // into the rows: Daily target
    await tick();
    ui.stdin.write(RIGHT);
    await until(ui.lastFrame, "8h 30m");
    expect(lastSaved(calls)?.day.target).toBe("8h30m");
    await down(ui, 3); // Starts, Ends, Round to
    ui.stdin.write(LEFT);
    await tick();
    expect(lastSaved(calls)?.day.round_to).toBe("5m");
    await down(ui, 1); // Idle cutoff
    ui.stdin.write(RIGHT);
    await tick();
    expect(lastSaved(calls)?.day.idle_cutoff).toBe("30m");
  });

  it("sets how descriptions are written in the AI helper section", async () => {
    const { ui, calls } = await openSetup();
    await down(ui, 2); // AI helper
    await until(ui.lastFrame, "Writes the descriptions");
    expect(ui.lastFrame()).toContain("Fix …");
    expect(ui.lastFrame()).toContain("3–8 words");
    ui.stdin.write(RIGHT); // into the rows: Helper
    await tick();
    await down(ui, 1); // Starts with (Model can't be changed here, so it's skipped)
    ui.stdin.write(RIGHT);
    await tick();
    expect(lastSaved(calls)?.descriptions.format).toBe("past");
    await down(ui, 1); // Length
    ui.stdin.write(RIGHT);
    await until(ui.lastFrame, "one sentence");
    expect(lastSaved(calls)?.descriptions.length).toBe("medium");
  });

  it("offers every agent installed here as the AI helper, and auto says which it uses", async () => {
    const helpers = [
      { id: "claude-code" as const, name: "Claude Code" },
      { id: "codex" as const, name: "Codex" },
    ];
    // Saving takes a while, as writing the file does: a second → before it's done still counts.
    const { ui, calls } = await openSetup({ setup: { helpers }, saveDelay: 50 });
    await down(ui, 2); // AI helper
    await until(ui.lastFrame, "using Claude Code");
    for (const label of ["Auto", "Claude Code", "Codex", "No AI"])
      expect(ui.lastFrame()).toContain(label);
    ui.stdin.write(RIGHT); // into the rows: Helper, on Auto
    await tick();
    ui.stdin.write(RIGHT); // → Claude Code
    await tick();
    ui.stdin.write(RIGHT); // → Codex, before Claude Code is saved
    for (let i = 0; i < 50 && calls.saved.length < 2; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect((calls.saved as Config[]).map((c) => c.ai.backend)).toEqual(["claude-code", "codex"]);
  });

  it("writes a description prompt on its own page: enter saves, esc leaves it as it was", async () => {
    const { ui, calls } = await openSetup();
    await down(ui, 2); // AI helper
    await until(ui.lastFrame, "describe how they should read");
    ui.stdin.write(RIGHT); // Helper
    await tick();
    await down(ui, 3); // Starts with, Length, Prompt
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Description prompt");
    ui.stdin.write(PASTE("Lead with the ticket key.\nWrite for a client, no jargon."));
    await tick();
    expect(ui.lastFrame()).toContain("56 / 2000");
    ui.stdin.write("\r");
    for (let i = 0; i < 50 && !lastSaved(calls)?.descriptions.instructions; i++) await tick();
    expect(lastSaved(calls)?.descriptions.instructions).toBe(
      "Lead with the ticket key. Write for a client, no jargon.",
    );
    for (let i = 0; i < 50 && (ui.lastFrame() ?? "").includes("Description prompt"); i++)
      await tick();
    expect(ui.lastFrame()).not.toContain("Description prompt"); // back on the section
    expect(ui.lastFrame()).toContain("Lead with the ticket key. Write for…");

    ui.stdin.write("\r"); // open it again: it holds what was saved
    await until(ui.lastFrame, "Description prompt");
    ui.stdin.write("\u0015"); // ctrl+u clears
    ui.stdin.write(PASTE("something else"));
    await tick();
    ui.stdin.write(ESC);
    await tick();
    expect(ui.lastFrame()).not.toContain("Description prompt");
    expect(lastSaved(calls)?.descriptions.instructions).toBe(
      "Lead with the ticket key. Write for a client, no jargon.",
    );
  });

  it("won't save a description prompt longer than config.toml takes", async () => {
    const { ui, calls } = await openSetup();
    await down(ui, 2);
    await until(ui.lastFrame, "describe how they should read");
    ui.stdin.write(RIGHT);
    await tick();
    await down(ui, 3);
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Description prompt");
    ui.stdin.write(PASTE("word ".repeat(450)));
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "keep it to 2000");
    expect(ui.lastFrame()).toContain("keep it to 2000");
    expect(calls.saved).toEqual([]);
  });

  it("shows what's set by saying it: task names and project rules", async () => {
    const { ui } = await openSetup();
    await down(ui, 3); // Projects
    await until(ui.lastFrame, "DEFAULT TASKS");
    const frame = ui.lastFrame() ?? "";
    expect(frame).toMatch(/Coding\s+Development/);
    expect(frame).toMatch(/Reviews\s+Code Review/);
    expect(frame).toContain("PROJECTS");
    expect(frame).toContain("Add project");
    expect(frame).toContain("say it in the chat bar");
  });

  it("adds a project by typing its name, and removes one with ⌫", async () => {
    const { ui, calls } = await openSetup();
    await down(ui, 3); // Projects
    await until(ui.lastFrame, "Add project");
    ui.stdin.write(RIGHT); // into the rows: the Add project field
    await tick();
    ui.stdin.write("Internal");
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "added by you");
    expect(lastSaved(calls)?.projects).toEqual([{ name: "Internal" }]);
    ui.stdin.write("\u001b[A"); // up to the Internal row
    await tick();
    ui.stdin.write("\u007f"); // ⌫
    await until(() => JSON.stringify(lastSaved(calls)?.projects), "[]");
    expect(lastSaved(calls)?.projects).toEqual([]);
  });

  it("opens Claude Code's projects with enter, filters them by typing, and esc goes back", async () => {
    const { ui, calls } = await openSetup();
    ui.stdin.write(RIGHT);
    await tick();
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Search Claude Code projects");
    ui.stdin.write("clock");
    await until(ui.lastFrame, "⌕ clock");
    expect(ui.lastFrame()).not.toContain("acme-api");
    ui.stdin.write(" ");
    await until(ui.lastFrame, "1 of 2 on");
    expect(lastSaved(calls)?.sources.find((s) => s.type === "claude-code")).toMatchObject({
      exclude: ["-Users-dev-code-clockout"],
    });
    ui.stdin.write(ESC); // clears the search
    await until(ui.lastFrame, "acme-api");
    ui.stdin.write(ESC); // back to the sources
    await until(ui.lastFrame, "What Clockout reads");
    expect(ui.lastFrame()).toContain("1 of 2 projects");
  });

  it("never forgets an ERP task on Enter; ⌫ does", async () => {
    const withErp = {
      ...config,
      timesheet: {
        type: "next-pms" as const,
        url: "https://erp.example.com",
        map: [{ project: "acme/api", erp_task: "TASK-1", label: "Acme API build" }],
      },
    };
    const { ui, calls } = await openSetup({
      setup: { config: withErp, erp: { connected: true, user: "dev@example.com" } },
    });
    for (let i = 0; i < 4; i++) {
      ui.stdin.write("\u001b[B");
      await tick();
    }
    await until(ui.lastFrame, "Acme API build");
    ui.stdin.write("\r"); // into the rows: the mapping
    await tick();
    ui.stdin.write("\r");
    ui.stdin.write(" ");
    await tick();
    expect(calls.saved).toEqual([]);
    expect(ui.lastFrame()).toContain("⌫ forget");
    ui.stdin.write("\u007f"); // backspace
    await until(ui.lastFrame, "No tasks picked yet");
    expect(lastSaved(calls)?.timesheet?.map).toEqual([]);
  });

  it("signs in to the ERP from the keyboard", async () => {
    const { ui, calls } = await openSetup();
    for (let i = 0; i < 4; i++) {
      ui.stdin.write("\u001b[B");
      await tick();
    }
    await until(ui.lastFrame, "ERP address");
    ui.stdin.write("\r"); // into the rows: the address
    await tick();
    ui.stdin.write("erp.example.com");
    await until(ui.lastFrame, "erp.example.com");
    ui.stdin.write("\r");
    await until(ui.lastFrame, "Days go to erp.example.com");
    expect(calls.signedIn).toEqual(["erp.example.com"]);
  });
});
