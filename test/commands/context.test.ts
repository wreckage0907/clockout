import { describe, expect, it } from "vitest";
import { resolveDate } from "../../src/commands/context";

const now = new Date("2026-10-16T20:00:00Z"); // already the 17th in Kolkata

describe("resolveDate", () => {
  it.each([
    [undefined, "2026-10-17"],
    ["today", "2026-10-17"],
    ["yesterday", "2026-10-16"],
    ["-3", "2026-10-14"],
    ["2026-10-01", "2026-10-01"],
  ])("%s → %s in the user's time zone", (input, expected) => {
    expect(resolveDate(input, "Asia/Kolkata", now)).toBe(expected);
  });

  it("explains dates it can't read", () => {
    expect(() => resolveDate("last tuesday", "Asia/Kolkata", now)).toThrow(/Use today, yesterday/);
    expect(() => resolveDate("2026-02-30", "Asia/Kolkata", now)).toThrow(/Can't read the date/);
    expect(() => resolveDate("2099-01-01", "Asia/Kolkata", now)).toThrow(/hasn't happened yet/);
    expect(resolveDate("2099-01-01", "Asia/Kolkata", now, { future: true })).toBe("2099-01-01");
  });
});
