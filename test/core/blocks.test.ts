import { describe, expect, it } from "vitest";
import { buildDay } from "../../src/core/blocks";
import { atLocalTime, localTime } from "../../src/core/time";
import { timesheetRows } from "../../src/core/timesheet";
import type { Activity, Day } from "../../src/core/types";
import { FIXTURE_DATE, fixtureActivities, fixtureConfig } from "../helpers/fixture-day";

const TZ = "Asia/Kolkata";
const D = "2026-10-20";
const at = (hhmm: string) => atLocalTime(D, hhmm, TZ);

function prompt(hhmm: string, extra: Partial<Activity> = {}): Activity {
  return {
    source: "test",
    kind: "prompt",
    actor: "human",
    start: at(hhmm),
    repo: "acme/api",
    branch: "main",
    sessionId: "s1",
    title: "Task A",
    ...extra,
  };
}

function meeting(from: string, to: string, extra: Partial<Activity> = {}): Activity {
  return {
    source: "test",
    kind: "meeting",
    actor: "human",
    start: at(from),
    end: at(to),
    title: "Sync",
    attendance: "accepted",
    refs: [`event:${from}`],
    ...extra,
  };
}

function rows(day: Day): string[] {
  return day.blocks.map(
    (b) =>
      `${localTime(b.start, TZ)}-${localTime(b.end, TZ)} ${b.kind}${b.confirmed ? "" : "?"} ${b.project} | ${b.task} | ${b.summary}`,
  );
}

describe("buildDay on the fixture day", async () => {
  const day = buildDay(FIXTURE_DATE, await fixtureActivities(), fixtureConfig());

  it("drafts blocks from sessions, PRs, reviews and meetings", () => {
    expect(rows(day)).toEqual([
      "09:30-10:00 meeting Meetings | Meetings | Daily standup",
      "10:00-12:15 work acme/api | Development | Fix auth token refresh (PR #87)",
      "14:00-16:33 work dev-example/clockout | Development | Build export command (PR #48)",
      "15:00-15:30 meeting? Meetings | Meetings | Design sync",
      "16:40-17:00 review acme/api | Code Review | Review Rate-limit login attempts (PR #212)",
      "17:30-18:00 meeting Meetings | Meetings | Focus: write release notes",
      "18:00-18:30 meeting? Meetings | Meetings | Acme weekly sync",
      "23:40-23:46 work acme/api | Development | Investigate flaky deploy",
    ]);
    expect(day.blocks.map((b) => b.id)).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"]);
  });

  it("asks about unconfirmed meetings and long gaps", () => {
    expect(day.questions.map((q) => [q.id, q.kind, q.blockId ?? q.gapId])).toEqual([
      ["q1", "attendance", "b4"],
      ["q2", "attendance", "b7"],
      ["q3", "gap", "g1"],
      ["q4", "gap", "g2"],
    ]);
    expect(day.questions[0]?.text).toContain("You were working on dev-example/clockout then.");
    expect(day.notes).toEqual(["Left out 1 declined meeting: Vendor demo"]);
  });

  it("exports confirmed blocks with rounded hours", () => {
    const sheet = timesheetRows(day, fixtureConfig());
    expect(sheet.map((r) => `${r.project}|${r.task}|${r.hours}`)).toEqual([
      "Meetings|Meetings|0.5",
      "acme/api|Development|2.25",
      "dev-example/clockout|Development|2.5",
      "acme/api|Code Review|0.25",
      "Meetings|Meetings|0.5",
      "acme/api|Development|0.25",
    ]);
  });
});

describe("buildDay rules", () => {
  const config = fixtureConfig();

  it("splits work when you're idle longer than the cutoff, and shows the gap", () => {
    const day = buildDay(D, [prompt("10:00"), prompt("10:10"), prompt("10:50")], config);
    expect(rows(day)).toEqual([
      "10:00-10:15 work acme/api | Development | Task A",
      "10:50-10:55 work acme/api | Development | Task A",
    ]);
    expect(day.gaps.map((g) => `${localTime(g.start, TZ)}-${localTime(g.end, TZ)}`)).toContain(
      "10:15-10:50",
    );
  });

  it("counts an agent's long run only up to the idle cutoff", () => {
    const turn: Activity = {
      source: "test",
      kind: "agent_turn",
      actor: "agent",
      start: at("10:01"),
      end: at("11:30"),
      sessionId: "s1",
      repo: "acme/api",
    };
    expect(rows(buildDay(D, [prompt("10:00"), turn], config))).toEqual([
      "10:00-10:20 work acme/api | Development | Task A",
    ]);
  });

  it("gives overlapping sessions' time to whichever you touched last", () => {
    const b = { repo: "acme/web", sessionId: "s2", title: "Task B" };
    const day = buildDay(
      D,
      [prompt("10:00"), prompt("10:06", b), prompt("10:12"), prompt("10:18", b)],
      config,
    );
    expect(rows(day)).toEqual([
      "10:00-10:06 work acme/api | Development | Task A",
      "10:06-10:12 work acme/web | Development | Task B",
      "10:12-10:17 work acme/api | Development | Task A",
      "10:17-10:23 work acme/web | Development | Task B",
    ]);
  });

  it("lets accepted meetings take their time from work, and asks if you were busy", () => {
    const day = buildDay(
      D,
      [
        prompt("10:00"),
        prompt("10:08"),
        prompt("10:16"),
        prompt("10:24"),
        meeting("10:05", "10:20"),
      ],
      config,
    );
    expect(rows(day)).toEqual([
      "10:00-10:05 work acme/api | Development | Task A",
      "10:05-10:20 meeting Meetings | Meetings | Sync",
      "10:20-10:29 work acme/api | Development | Task A",
    ]);
    expect(day.questions[0]?.text).toMatch(/You were active in acme\/api during "Sync"/);
  });

  it("applies project rules by repo, title and attendee domain", () => {
    const ruled = fixtureConfig({
      projects: [
        { name: "Acme", task: "Backend", match: { repo: "ACME/api" } },
        { name: "Acme", match: { attendee_domain: "acme.example" } },
      ],
    });
    const day = buildDay(
      D,
      [prompt("10:00"), meeting("11:00", "11:30", { attendees: ["pm@acme.example"] })],
      ruled,
    );
    expect(rows(day)).toEqual([
      "10:00-10:05 work Acme | Backend | Task A",
      "11:00-11:30 meeting Acme | Meetings | Sync",
    ]);
  });

  it("mentions a running agent when asking about a gap", () => {
    const short = fixtureConfig({
      day: { working_hours: "10:00-11:00", idle_cutoff: "20m", round_to: "15m" },
    });
    const turn: Activity = {
      source: "test",
      kind: "agent_turn",
      actor: "agent",
      start: at("10:01"),
      end: at("11:00"),
      sessionId: "s1",
      repo: "acme/api",
    };
    const day = buildDay(D, [prompt("10:00"), turn], short);
    expect(day.questions.map((q) => q.text)).toEqual([
      "Nothing from you 10:20–11:00, but an agent was working in acme/api for 40 min. Were you on it, or away?",
    ]);
  });

  it("drops declined meetings with a note and clips meetings at midnight", () => {
    const day = buildDay(
      D,
      [
        meeting("09:00", "09:30", { attendance: "declined", title: "Demo" }),
        meeting("23:30", "23:59"),
      ],
      config,
    );
    expect(rows(day)).toEqual(["23:30-23:59 meeting Meetings | Meetings | Sync"]);
    expect(day.notes).toEqual(["Left out 1 declined meeting: Demo"]);
  });
});
