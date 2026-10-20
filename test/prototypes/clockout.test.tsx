import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { buildDay } from "../../src/core/blocks";
import type { Day } from "../../src/core/types";
import { choicesFor, parseDuration } from "../../src/prototypes/answers";
import { Clockout } from "../../src/prototypes/Clockout";
import { buildCards } from "../../src/prototypes/model";
import { hm } from "../../src/tui/theme";
import { FIXTURE_DATE, fixtureActivities, fixtureConfig } from "../helpers/fixture-day";

const config = fixtureConfig();
const activities = await fixtureActivities();
const day: Day = buildDay(FIXTURE_DATE, activities, config);
const W = 120;
const H = 40;
const tick = () => new Promise((r) => setTimeout(r, 30));
const DOWN = "\u001b[B";

async function openDay() {
  const app = render(<Clockout day={day} config={config} width={W} height={H} />);
  await tick();
  app.stdin.write("\r");
  await tick();
  return app;
}

describe("prototype helpers", () => {
  it("writes every duration one way", () => {
    expect(hm(45)).toBe("45m");
    expect(hm(60)).toBe("1h");
    expect(hm(135)).toBe("2h 15m");
  });

  it("reads durations the way people type them", () => {
    expect(parseDuration("1h")).toBe(60);
    expect(parseDuration("1h 45")).toBe(105);
    expect(parseDuration("1h15")).toBe(75);
    expect(parseDuration("45m")).toBe(45);
    expect(parseDuration("45 minutes")).toBe(45);
    expect(parseDuration("1:30")).toBe(90);
    expect(parseDuration("1.75")).toBe(105);
    expect(parseDuration("90")).toBe(90);
    expect(parseDuration("lunch")).toBeNull();
  });

  it("offers one-key answers for meetings", () => {
    const meeting = day.questions.find((q) => q.text.includes("Design sync"));
    if (!meeting) throw new Error("fixture day changed");
    expect(choicesFor(day, meeting).map((c) => c.label)).toEqual(["Attended", "Skipped"]);
  });

  it("makes one card per timesheet row, in the order the work started, and meetings to answer", () => {
    const cards = buildCards(day, config, {});
    expect(cards.map((c) => `${c.kind}:${c.title}:${hm(c.minutes)}`).slice(0, 4)).toEqual([
      "row:Daily standup:30m",
      "row:Fix auth token refresh (PR #87):2h 15m",
      "row:Build export command (PR #48):2h 30m",
      "ask:Design sync:30m",
    ]);
    expect(cards[1]?.from).toBe("Claude Code + GitHub · 17 prompts in 1 session · opened PR #87");
  });

  it("an hours override replaces the computed hours and nothing else", () => {
    const before = buildCards(day, config, {});
    const key = before[0]?.key ?? "";
    const after = buildCards(day, config, { [key]: 45 });
    expect(after[0]).toMatchObject({ minutes: 45, edited: true });
    expect(after.slice(1)).toEqual(before.slice(1));
  });
});

describe("clockout prototype", () => {
  it("home is the logo on the hours bar, the total, and the chat bar; nothing else", async () => {
    const { lastFrame } = render(<Clockout day={day} config={config} width={W} height={H} />);
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("5h 45m of 8h");
    expect(frame).toContain("Tell me about your day");
    expect(frame).toContain("Today · Fri, Oct 16 ▾");
    expect(frame).toContain("Setup");
    for (const gone of ["things to check", "haiku", "commands", "untracked"])
      expect(frame).not.toContain(gone);
  });

  it("enter opens the day as cards with big durations", async () => {
    const { lastFrame } = await openDay();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Fix auth token refresh (PR #87)");
    expect(frame).toContain("2h 15m");
    expect(frame).toContain("Did you attend “Design sync”?");
    expect(frame).toContain("Copy sheet");
  });

  it("typing a duration into a card sets it, and the total moves by exactly the difference", async () => {
    const { lastFrame, stdin } = await openDay();
    stdin.write(DOWN);
    await tick();
    stdin.write(DOWN); // Fix auth token refresh, 2h 15m
    await tick();
    stdin.write("\r"); // edit the pill
    await tick();
    stdin.write("1h 45");
    await tick();
    stdin.write("\r");
    await tick();
    expect(lastFrame()).toContain("5h 15m of 8h");
    expect(lastFrame()).toContain("set by you");
  });

  it("+ nudges the selected card by the rounding step", async () => {
    const { lastFrame, stdin } = await openDay();
    stdin.write(DOWN); // Daily standup, 30m
    await tick();
    stdin.write("+");
    await tick();
    expect(lastFrame()).toContain("6h of 8h");
  });

  it("answering a meeting puts it on the sheet without counting the overlap twice", async () => {
    const { lastFrame, stdin } = await openDay();
    for (let i = 0; i < 4; i++) {
      stdin.write(DOWN); // Design sync
      await tick();
    }
    stdin.write("\r"); // Attended
    await tick();
    // It overlapped 30 minutes of coding: the meeting takes them, so the total holds.
    expect(lastFrame()).toContain("5h 45m of 8h");
    expect(lastFrame()).not.toContain("Did you attend “Design sync”?");
    expect(lastFrame()).toContain("2h");
  });

  it("ctrl+p opens setup and esc closes it", async () => {
    const { lastFrame, stdin } = render(
      <Clockout day={day} config={config} width={W} height={H} />,
    );
    await tick();
    stdin.write("\u0010");
    await tick();
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Tick what Clockout reads");
    expect(frame).toContain("Google Calendar");
    expect(frame).toContain("not installed");
    stdin.write("\u001b");
    await tick();
    expect(lastFrame()).not.toContain("Tick what Clockout reads");
  });
});
