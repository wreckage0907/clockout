import { describe, expect, it } from "vitest";
import { applyEdits } from "../../src/core/edits";
import {
  branchesWithoutPr,
  dayItems,
  type OpenWork,
  plainSections,
  previousWorkingDay,
  renderStandup,
  type StandupFacts,
  todaysMeetings,
} from "../../src/core/standup";
import type { Activity } from "../../src/core/types";
import { config, fixtureDay } from "../helpers/fake-app";
import { fixtureConfig } from "../helpers/fixture-day";

const facts: StandupFacts = {
  date: "2026-10-19",
  yesterday: {
    date: "2026-10-16",
    items: [
      {
        kind: "work",
        project: "acme/api",
        description: "Fix auth token refresh (PR #87)",
        hours: 1.25,
      },
      { kind: "review", project: "acme/web", description: "Review sam's PR #91", hours: 0.5 },
      { kind: "meeting", project: "Meetings", description: "Daily standup", hours: 0.25 },
    ],
  },
  meetings: [{ title: "Design sync", time: "15:00" }],
  prs: [
    { repo: "acme/api", number: 88, title: "Rate limit login", branch: "feat/login-rate-limit" },
    { repo: "acme/api", number: 89, title: "New billing page", draft: true },
  ],
  reviews: [{ repo: "acme/web", number: 92, title: "Dark mode", author: "sam" }],
  branches: [{ repo: "acme/api", branch: "spike/cache" }],
  blockers: [],
};

describe("the previous working day", () => {
  it("is Friday on a Monday, Saturday or Sunday, else the day before", () => {
    expect(previousWorkingDay("2026-10-19")).toBe("2026-10-16"); // Monday
    expect(previousWorkingDay("2026-10-18")).toBe("2026-10-16"); // Sunday
    expect(previousWorkingDay("2026-10-17")).toBe("2026-10-16"); // Saturday
    expect(previousWorkingDay("2026-10-16")).toBe("2026-10-15"); // Friday
    expect(previousWorkingDay("2026-11-03")).toBe("2026-11-02"); // across a month
  });
});

describe("standup facts", () => {
  it("takes the day's timesheet rows with their kind, corrections and all", () => {
    const corrected = applyEdits(fixtureDay, [{ op: "update", id: "b1", minutes: 45 }], config).day;
    const items = dayItems(corrected, config);
    expect(items.find((i) => i.description === "Daily standup")).toEqual({
      kind: "meeting",
      project: "Meetings",
      description: "Daily standup",
      hours: 0.75,
    });
    expect(items.every((i) => i.hours > 0)).toBe(true);
    // Unconfirmed meetings aren't on the timesheet, so not in the standup either.
    expect(items.map((i) => i.description)).not.toContain("Design sync");
  });

  it("lists today's meetings in order, without declined, repeated or left-out ones", () => {
    const at = (iso: string, title: string, extra: Partial<Activity> = {}): Activity => ({
      source: "calendar",
      kind: "meeting",
      actor: "human",
      start: new Date(iso),
      title,
      ...extra,
    });
    const meetings = todaysMeetings(
      [
        at("2026-10-19T09:30:00Z", "Design sync"),
        at("2026-10-19T04:00:00Z", "Daily standup"),
        at("2026-10-19T04:00:00Z", "Daily standup", { source: "google-calendar" }),
        at("2026-10-19T06:00:00Z", "Vendor demo", { attendance: "declined" }),
        at("2026-10-19T07:00:00Z", "Gym"),
      ],
      fixtureConfig({ projects: [{ name: "Gym", ignore: true, match: { title: "^Gym$" } }] }),
      "Asia/Kolkata",
    );
    expect(meetings).toEqual([
      { title: "Daily standup", time: "09:30" },
      { title: "Design sync", time: "15:00" },
    ]);
  });

  it("finds branches you worked on that no pull request of yours covers", () => {
    const none: OpenWork = { prs: [], reviews: [], finished: {} };
    // main is never a branch to finish.
    expect(branchesWithoutPr(fixtureDay, none)).toEqual([
      { repo: "acme/api", branch: "fix/auth-refresh" },
      { repo: "dev-example/clockout", branch: "feat/export" },
    ]);
    const open: OpenWork = {
      prs: [{ repo: "acme/api", number: 87, title: "Fix", branch: "fix/auth-refresh" }],
      reviews: [],
      finished: { "dev-example/clockout": ["feat/export"] },
    };
    expect(branchesWithoutPr(fixtureDay, open)).toEqual([]);
    // The same branch name in another repo isn't covered.
    const elsewhere: OpenWork = { ...none, finished: { "acme/web": ["feat/export"] } };
    expect(branchesWithoutPr(fixtureDay, elsewhere)).toHaveLength(2);
  });
});

describe("the plain standup", () => {
  it("says what was on the timesheet and what's open, meetings on one line", () => {
    expect(plainSections(facts)).toEqual({
      yesterday: [
        "Fix auth token refresh (PR #87) (acme/api)",
        "Review sam's PR #91",
        "Meetings: Daily standup",
      ],
      today: [
        "Follow up on PR #88 Rate limit login (acme/api)",
        "Finish PR #89 New billing page (acme/api)",
        "Continue spike/cache (acme/api)",
        "Review PR #92 Dark mode (acme/web, sam)",
        "Meetings: Design sync 15:00",
      ],
    });
  });

  it("names Friday on a Monday, and says None for blockers you didn't give", () => {
    const text = renderStandup({ yesterday: ["Fix auth"], today: [] }, facts, {
      format: "bullets",
    });
    expect(text).toBe("Friday\n- Fix auth\n\nToday\n- Nothing planned yet\n\nBlockers\n- None");
  });

  it("says Yesterday for the day before, and keeps your blockers word for word", () => {
    const text = renderStandup(
      { yesterday: [], today: ["Ship it"] },
      { ...facts, date: "2026-10-17", blockers: ["Waiting on API keys from Acme"] },
      { format: "bullets" },
    );
    expect(text.split("\n\n")).toEqual([
      "Yesterday\n- Nothing on the timesheet",
      "Today\n- Ship it",
      "Blockers\n- Waiting on API keys from Acme",
    ]);
  });

  it("reads as sentences in prose", () => {
    const text = renderStandup(
      { yesterday: ["Fixed auth.", "Reviewed PR #91"], today: ["Finish rate limiting"] },
      facts,
      { format: "prose" },
    );
    expect(text).toBe(
      "Friday: Fixed auth; Reviewed PR #91.\nToday: Finish rate limiting.\nBlockers: None.",
    );
  });
});
