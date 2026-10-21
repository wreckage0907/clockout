import { describe, expect, it } from "vitest";
import { applyEdits } from "../../src/core/edits";
import { setRowMinutesOps } from "../../src/core/timesheet";
import { buildCards, segments } from "../../src/tui/cards";
import { choicesFor, meetingOf } from "../../src/tui/questions";
import { hm } from "../../src/tui/theme";
import { config, fixtureDay as day } from "../helpers/fake-app";

describe("cards", () => {
  it("writes every duration one way", () => {
    expect(hm(45)).toBe("45m");
    expect(hm(60)).toBe("1h");
    expect(hm(135)).toBe("2h 15m");
  });

  it("makes one card per timesheet row, in the order the work started, plus meetings to answer", () => {
    const cards = buildCards(day, config);
    expect(cards.map((c) => `${c.kind}:${c.title}:${hm(c.minutes)}`).slice(0, 4)).toEqual([
      "row:Daily standup:30m",
      "row:Fix auth token refresh (PR #87):2h 15m",
      "row:Build export command (PR #48):2h 30m",
      "ask:Design sync:30m",
    ]);
    expect(cards[1]?.from).toBe(
      "Claude Code + GitHub · 17 prompts in 1 session · opened PR #87 · commented on issue #90",
    );
  });

  it("asks only about meetings: untracked time goes through the Add time card", () => {
    const asks = buildCards(day, config).filter((c) => c.kind === "ask");
    expect(asks.map((c) => c.title)).toEqual([
      "Design sync",
      "Focus: write release notes",
      "Acme weekly sync",
    ]);
    expect(day.questions.filter((q) => q.kind === "gap")).toHaveLength(2);
  });

  it("offers one-key answers for meetings", () => {
    const q = day.questions.find((x) => x.text.includes("Design sync"));
    const meeting = q && meetingOf(day, q);
    if (!q || !meeting) throw new Error("fixture day changed");
    expect(choicesFor(meeting, q).map((c) => c.label)).toEqual(["Attended", "Skipped"]);
  });

  it("a length you set shows exactly, marked as yours, and nothing else moves", () => {
    const before = buildCards(day, config);
    const row = before[1];
    if (!row) throw new Error("fixture day changed");
    const after = buildCards(
      applyEdits(day, setRowMinutesOps(day, row.key, 100), config).day,
      config,
    );
    expect(after[1]).toMatchObject({ minutes: 100, edited: true });
    expect(after.filter((_, i) => i !== 1)).toEqual(before.filter((_, i) => i !== 1));
  });

  it("splits the day's hours by project for the bar", () => {
    expect(segments(buildCards(day, config)).map((s) => `${s.label} ${hm(s.minutes)}`)).toEqual([
      "acme/api 3h",
      "clockout 2h 30m",
      "Meetings 30m",
    ]);
  });
});
