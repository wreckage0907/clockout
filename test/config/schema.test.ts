import { describe, expect, it } from "vitest";
import { configSchema, durationMinutes } from "../../src/config/schema";

const minimal = {
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
};

function issues(input: unknown): string[] {
  const r = configSchema.safeParse(input);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

describe("configSchema", () => {
  it("fills defaults for a minimal config", () => {
    const c = configSchema.parse(minimal);
    expect(c.day).toEqual({ working_hours: "09:30-18:30", idle_cutoff: "20m", round_to: "15m" });
    expect(c.tasks).toEqual({ work: "Development", review: "Code Review", meeting: "Meetings" });
    expect(c.ai.backend).toBe("auto");
    expect(c.sources).toEqual([]);
  });

  it("accepts every MVP source", () => {
    const c = configSchema.parse({
      ...minimal,
      sources: [
        { type: "claude-code" },
        { type: "github" },
        { type: "calendar", method: "ics", url: "https://calendar.google.com/x/basic.ics" },
      ],
    });
    expect(c.sources.map((s) => s.type)).toEqual(["claude-code", "github", "calendar"]);
  });

  it("rejects an unknown time zone", () => {
    expect(issues({ ...minimal, me: { ...minimal.me, timezone: "India/Bangalore" } })).toEqual([
      "me.timezone",
    ]);
  });

  it("rejects working hours that end before they start", () => {
    expect(issues({ ...minimal, day: { working_hours: "18:00-09:00" } })).toEqual([
      "day.working_hours",
    ]);
  });

  it("rejects bad durations", () => {
    expect(issues({ ...minimal, day: { idle_cutoff: "20 minutes", round_to: "0m" } })).toEqual([
      "day.idle_cutoff",
      "day.round_to",
    ]);
  });

  it("rejects a plain-http calendar URL", () => {
    const bad = {
      ...minimal,
      sources: [{ type: "calendar", method: "ics", url: "http://x.test/a.ics" }],
    };
    expect(issues(bad)).toEqual(["sources.0.url"]);
  });

  it("rejects a project rule with nothing to match", () => {
    expect(issues({ ...minimal, projects: [{ name: "Acme", match: {} }] })).toEqual([
      "projects.0.match",
    ]);
  });
});

describe("durationMinutes", () => {
  it.each([
    ["15m", 15],
    ["1h", 60],
    ["1h30m", 90],
  ])("%s → %i", (s, m) => expect(durationMinutes(s)).toBe(m));
});
