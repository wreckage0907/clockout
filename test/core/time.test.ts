import { describe, expect, it } from "vitest";
import {
  addDays,
  atLocalTime,
  dayRange,
  formatDuration,
  localDate,
  localTime,
  parseDuration,
  roundedHours,
} from "../../src/core/time";

describe("time helpers", () => {
  it("finds local midnight to midnight", () => {
    expect(dayRange("2026-10-16", "Asia/Kolkata")).toEqual({
      from: new Date("2026-10-15T18:30:00Z"),
      to: new Date("2026-10-16T18:30:00Z"),
    });
  });

  it("handles a daylight-saving change (23-hour day)", () => {
    const { from, to } = dayRange("2026-03-08", "America/New_York");
    expect((to.getTime() - from.getTime()) / 3_600_000).toBe(23);
  });

  it("converts between local wall-clock and UTC", () => {
    const at = atLocalTime("2026-10-16", "09:30", "Asia/Kolkata");
    expect(at.toISOString()).toBe("2026-10-16T04:00:00.000Z");
    expect(localTime(at, "Asia/Kolkata")).toBe("09:30");
    expect(localDate(new Date("2026-10-16T18:40:00Z"), "Asia/Kolkata")).toBe("2026-10-17");
  });

  it("adds days across month ends", () => {
    expect(addDays("2026-10-31", 1)).toBe("2026-11-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("rounds hours to the step, never down to zero", () => {
    expect(roundedHours(95, 15)).toBe(1.5);
    expect(roundedHours(98, 15)).toBe(1.75);
    expect(roundedHours(4, 15)).toBe(0.25);
    expect(roundedHours(0, 15)).toBe(0);
  });

  it("formats durations", () => {
    expect(formatDuration(95)).toBe("1h35");
    expect(formatDuration(50)).toBe("0h50");
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

  it("reads any decimal as hours, and rejects minutes past 59", () => {
    expect(parseDuration("12")).toBe(720);
    expect(parseDuration("13")).toBe(13);
    expect(parseDuration("12.5")).toBe(750);
    expect(parseDuration("1:60")).toBeNull();
    expect(parseDuration("1h 75m")).toBeNull();
  });
});
