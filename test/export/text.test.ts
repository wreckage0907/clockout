import { describe, expect, it } from "vitest";
import { buildDay } from "../../src/core/blocks";
import { renderDay } from "../../src/export/text";
import { FIXTURE_DATE, fixtureActivities, fixtureConfig } from "../helpers/fixture-day";

describe("renderDay", async () => {
  const config = fixtureConfig();
  const out = renderDay(buildDay(FIXTURE_DATE, await fixtureActivities(), config), config, false);
  const lines = out.split("\n");

  it("leads with the date, total hours and open questions", () => {
    expect(lines[0]).toBe("clockout · Fri 2026-10-16 · Asia/Kolkata    6.25h · 4 questions");
  });

  it("lists blocks and gaps in time order, marking unconfirmed meetings", () => {
    const b2 = lines.find((l) => l.includes(" b2 "));
    expect(b2).toMatch(
      /^ {3}b2 {2}10:00–12:15 {2}2h15 {2}2\.25h {2}acme\/api +Fix auth token refresh \(PR #87\)$/,
    );
    expect(lines.some((l) => l.includes("12:15–14:00") && l.includes("── gap ──"))).toBe(true);
    expect(lines.some((l) => l.startsWith("?  b4") && l.includes("Design sync"))).toBe(true);
  });

  it("ends with questions and notes", () => {
    expect(out).toContain('Questions\n  q1  Did you attend "Design sync"');
    expect(out).toMatch(/Notes\n {2}Left out 1 declined meeting: Vendor demo$/);
  });
});
