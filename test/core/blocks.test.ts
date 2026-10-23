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
      "16:33-17:00 review acme/api | Code Review | Review Rate-limit login attempts (PR #212)",
      "17:30-18:00 meeting? Meetings | Meetings | Focus: write release notes",
      "18:00-18:30 meeting? Meetings | Meetings | Acme weekly sync",
      "23:40-23:46 work acme/api | Development | Investigate flaky deploy",
    ]);
    expect(day.blocks.map((b) => b.id)).toEqual(["b1", "b2", "b3", "b4", "b5", "b6", "b7", "b8"]);
  });

  it("asks about unconfirmed meetings and long gaps", () => {
    expect(day.questions.map((q) => [q.id, q.kind, q.blockId ?? q.gapId])).toEqual([
      ["q1", "attendance", "b4"],
      ["q2", "attendance", "b6"],
      ["q3", "attendance", "b7"],
      ["q4", "gap", "g1"],
      ["q5", "gap", "g2"],
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
      "acme/api|Code Review|0.5",
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
      day: { working_hours: "10:00-11:00", idle_cutoff: "20m", round_to: "15m", target: "8h" },
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

  it("asks what a long gap was, naming the work around it, and offers lunch only around midday", () => {
    const short = fixtureConfig({
      day: { working_hours: "10:00-19:00", idle_cutoff: "20m", round_to: "15m", target: "8h" },
    });
    const day = buildDay(
      D,
      [
        prompt("10:00"),
        prompt("10:15"),
        prompt("12:45"),
        prompt("13:30"),
        prompt("16:00", { repo: "acme/web", sessionId: "s2" }),
        prompt("16:15", { repo: "acme/web", sessionId: "s2" }),
        prompt("17:30", { repo: "acme/web", sessionId: "s2" }),
      ],
      short,
    );
    expect(day.questions.map((q) => q.text)).toEqual([
      "Nothing recorded 10:20–12:45 (2h25). What were you working on? You were on acme/api before and after.",
      "Nothing recorded 12:50–13:30. Lunch, a break, or work?",
      "Nothing recorded 13:35–16:00 (2h25). What were you working on? You were on acme/api before it and acme/web after.",
      "Nothing recorded 16:20–17:30. A break, or work?",
      "Nothing recorded 17:35–19:00. A break, or work?",
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

describe("ignore rules", () => {
  const base = fixtureConfig();

  it("leave out a project by its name, however it was found, with a note", () => {
    const config = { ...base, projects: [{ name: "dotfiles", ignore: true }] };
    const day = buildDay(
      D,
      [
        prompt("10:00"),
        prompt("11:00", { repo: undefined, cwd: "/Users/ada/src/dotfiles", sessionId: "s2" }),
        prompt("11:10", { repo: undefined, cwd: "/Users/ada/src/Dotfiles", sessionId: "s2" }),
      ],
      config,
    );
    expect(day.blocks.map((b) => b.project)).toEqual(["acme/api"]);
    expect(day.notes).toEqual(["Left out dotfiles: your project rules ignore it"]);
  });

  it("leave out what a rule matches: a repo's work, a meeting by its title", () => {
    const config = {
      ...base,
      projects: [
        { name: "Personal", ignore: true, match: { repo: "ada/blog" } },
        { name: "Gym", ignore: true, match: { title: "(?i)^gym$" } },
      ],
    };
    const day = buildDay(
      D,
      [
        prompt("10:00"),
        prompt("11:00", { repo: "ada/blog", sessionId: "s2" }),
        meeting("13:00", "14:00", { title: "GYM", attendees: [] }),
        meeting("15:00", "15:30"),
      ],
      config,
    );
    expect(rows(day).map((r) => r.split(" | ")[0])).toEqual([
      "10:00-10:05 work acme/api",
      "15:00-15:30 meeting Meetings",
    ]);
    expect(day.notes).toEqual(["Left out Personal, Gym: your project rules ignore it"]);
  });

  it("an agent working in an ignored project doesn't make a gap question about it", () => {
    const config = { ...base, projects: [{ name: "ada/blog", ignore: true }] };
    const turn: Activity = {
      source: "test",
      kind: "agent_turn",
      actor: "agent",
      start: at("10:30"),
      end: at("11:30"),
      repo: "ada/blog",
      sessionId: "s2",
    };
    const day = buildDay(D, [prompt("10:00"), turn, prompt("12:00")], config);
    expect(day.questions.map((q) => q.text).join(" ")).not.toContain("ada/blog");
  });
});

describe("timesheetRows", () => {
  it("merges blocks of the same work into one entry, rounding the total once", () => {
    const config = fixtureConfig();
    const day = buildDay(
      D,
      [prompt("10:00"), prompt("10:07"), prompt("11:00"), prompt("11:04")],
      config,
    );
    expect(day.blocks).toHaveLength(2); // 10:00-10:12 and 11:00-11:09, split by idle time
    expect(timesheetRows(day, config)).toEqual([
      { date: D, project: "acme/api", task: "Development", hours: 0.25, description: "Task A" },
    ]);
  });
});

describe("review fixes", () => {
  const config = fixtureConfig();

  it("asks whether blocks on your own calendar were work instead of billing them", async () => {
    const day = buildDay(FIXTURE_DATE, await fixtureActivities(), config);
    expect(day.questions.find((q) => q.blockId === "b6")?.text).toBe(
      'Was "Focus: write release notes" (17:30–18:00) work? It\'s a block on your own calendar.',
    );
  });

  it("counts only the first of two overlapping accepted meetings, and asks about the other", () => {
    const guests = { attendees: ["x@example.com"] };
    const day = buildDay(
      D,
      [
        meeting("10:00", "11:00", { ...guests, title: "A" }),
        meeting("10:30", "11:30", { ...guests, title: "B" }),
      ],
      config,
    );
    expect(rows(day)).toEqual([
      "10:00-11:00 meeting Meetings | Meetings | A",
      "10:30-11:30 meeting? Meetings | Meetings | B",
    ]);
    expect(day.questions[0]).toMatchObject({ kind: "overlap", blockId: "b2" });
    expect(timesheetRows(day, config).reduce((s, r) => s + r.hours, 0)).toBe(1);
  });
});

describe("GitHub activity", () => {
  const config = fixtureConfig();
  const pr = (kind: Activity["kind"], hhmm: string, extra: Partial<Activity> = {}): Activity => ({
    source: "github",
    kind,
    actor: "human",
    start: at(hhmm),
    title: "Rate-limit login attempts",
    repo: "acme/api",
    branch: "feat/login-rate-limit",
    refs: ["pr:acme/api#212", "author:sam-example"],
    ...extra,
  });

  it("counts the reading before an approval with no comments", () => {
    expect(rows(buildDay(D, [pr("review", "15:00")], config))).toEqual([
      "14:45-15:05 review acme/api | Code Review | Review Rate-limit login attempts (PR #212)",
    ]);
  });

  it("gives the reading time only where you weren't doing something else", () => {
    const day = buildDay(D, [prompt("14:30"), prompt("14:40"), pr("review", "15:00")], config);
    expect(rows(day)).toEqual([
      "14:30-14:45 work acme/api | Development | Task A",
      "14:45-15:05 review acme/api | Code Review | Review Rate-limit login attempts (PR #212)",
    ]);
  });

  it("counts trying out a PR you reviewed on its branch as reviewing it", () => {
    for (const branch of ["pr-212", "feat/login-rate-limit", "pull/212/head"]) {
      const day = buildDay(
        D,
        [
          prompt("14:00", { branch, title: "Verify PR 212 locally" }),
          prompt("14:15", { branch, title: "Verify PR 212 locally" }),
          pr("review", "14:30"),
        ],
        config,
      );
      expect(rows(day)).toEqual([
        "14:00-14:35 review acme/api | Code Review | Review Rate-limit login attempts (PR #212)",
      ]);
    }
  });

  it("counts a session as reviewing when it switched to the PR's branch or names the PR", () => {
    const turn: Activity = {
      source: "test",
      kind: "agent_turn",
      actor: "agent",
      start: at("14:01"),
      end: at("14:10"),
      sessionId: "s1",
      repo: "acme/api",
      branch: "pr-212",
    };
    const onDevelop = { branch: "develop", title: "Check the login fix" };
    for (const [extra, acts] of [
      [onDevelop, [turn]],
      [{ branch: "develop", title: "Verify PR #212 locally" }, []],
    ] as const) {
      const day = buildDay(
        D,
        [prompt("14:00", extra), prompt("14:12", extra), ...acts, pr("review", "14:30")],
        config,
      );
      expect(day.blocks.map((b) => `${b.kind} ${b.task}`)).toEqual(["review Code Review"]);
    }
  });

  it("leaves a branch that only mentions a number alone", () => {
    const day = buildDay(
      D,
      [prompt("14:00", { branch: "fix/issue-212" }), pr("review", "16:00")],
      config,
    );
    expect(day.blocks.map((b) => b.kind)).toEqual(["work", "review"]);
  });

  it("folds a comment on an issue into what you were doing in that project", () => {
    const comment: Activity = {
      source: "github",
      kind: "comment",
      actor: "human",
      start: at("10:12"),
      title: "Token refresh logs users out",
      repo: "acme/api",
      refs: ["issue:acme/api#90"],
    };
    const day = buildDay(D, [prompt("10:00"), prompt("10:08"), comment], config);
    expect(rows(day)).toEqual(["10:00-10:17 work acme/api | Development | Task A"]);
    expect(day.blocks[0]?.evidence.map((a) => a.kind)).toEqual(["prompt", "prompt", "comment"]);
  });

  it("gives a comment on its own a block named after the issue", () => {
    const comment: Activity = {
      source: "github",
      kind: "comment",
      actor: "human",
      start: at("12:00"),
      title: "Token refresh logs users out",
      repo: "acme/api",
      refs: ["issue:acme/api#90"],
    };
    expect(rows(buildDay(D, [comment], config))).toEqual([
      "12:00-12:05 work acme/api | Development | Discuss Token refresh logs users out (#90)",
    ]);
  });
});
