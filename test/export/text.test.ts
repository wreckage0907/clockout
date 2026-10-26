import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { buildDay } from "../../src/core/blocks";
import { atLocalTime } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { renderDay } from "../../src/export/text";
import { FIXTURE_DATE, fixtureActivities, fixtureConfig } from "../helpers/fixture-day";

describe("renderDay", async () => {
  const config = fixtureConfig();
  const out = renderDay(buildDay(FIXTURE_DATE, await fixtureActivities(), config), config, false);
  const lines = out.split("\n");

  it("leads with the date, total hours and open questions", () => {
    expect(lines[0]).toBe("clockout · Fri 2026-10-16 · Asia/Kolkata    6.00h · 5 questions");
  });

  it("lists blocks and gaps in time order, marking unconfirmed meetings", () => {
    const b2 = lines.find((l) => l.includes(" b2 "));
    expect(b2).toMatch(
      /^ {3}b2 {2}10:00–12:15 {2}2h15 {2}acme\/api +Fix auth token refresh \(PR #87\)$/,
    );
    expect(lines.some((l) => l.includes("12:15–14:00") && l.includes("── gap ──"))).toBe(true);
    expect(lines.some((l) => l.startsWith("?  b4") && l.includes("Design sync"))).toBe(true);
  });

  it("lists the timesheet rows, which add up to the header's total", () => {
    const sheet = out.slice(out.indexOf("Timesheet\n"), out.indexOf("\n\nQuestions"));
    const hours = [...sheet.matchAll(/^ +(\d+\.\d\d)h /gm)].map((m) => Number(m[1]));
    expect(sheet).toMatch(/^ +2\.25h {2}acme\/api +Fix auth token refresh \(PR #87\)$/m);
    expect(hours.reduce((a, b) => a + b, 0)).toBe(6);
  });

  it("ends with questions, how to answer them, and notes", () => {
    expect(out).toContain('Questions\n  q1  Did you attend "Design sync"');
    expect(out).toContain(
      'Answer in the app (clockout), or: clockout edit "the 12:15 gap was lunch"',
    );
    expect(out).toMatch(/Notes\n {2}Left out 1 declined meeting: Vendor demo$/);
  });
});

describe("a recorded meeting on the printed day", () => {
  const config = configSchema.parse({
    me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
  });
  const at = (hhmm: string) => atLocalTime("2026-10-16", hhmm, "Asia/Kolkata");
  const meeting: Activity = {
    source: "wispr-flow",
    kind: "meeting",
    actor: "human",
    start: at("10:00"),
    end: at("10:47"),
    title: "Design review",
    attendance: "accepted",
    recorded: true,
    refs: ["recording:rec-1"],
    notes: "Agreed on the new card layout.\nSecond line.",
  };
  const out = renderDay(buildDay("2026-10-16", [meeting], config), config, false);

  it("says what the recording was about, on one line", () => {
    expect(out).toContain("        “Agreed on the new card layout. Second line.”");
  });

  it("keeps it out of the timesheet it prints", () => {
    const sheet = out.slice(out.indexOf("Timesheet"));
    expect(sheet).toContain("Design review");
    expect(sheet).not.toContain("Agreed on the new card layout");
  });
});
