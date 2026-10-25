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
    expect(c.day).toEqual({
      working_hours: "09:30-18:30",
      idle_cutoff: "20m",
      round_to: "15m",
      target: "8h",
    });
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

  it("takes MCP servers by name, https or on this machine only", () => {
    const c = configSchema.parse({
      ...minimal,
      mcp: [
        { name: "wispr", url: "https://api.wisprflow.ai/connect/mcp" },
        { name: "mock", url: "http://127.0.0.1:4200/mcp" },
      ],
    });
    expect(c.mcp.map((s) => s.name)).toEqual(["wispr", "mock"]);
    expect(configSchema.parse(minimal).mcp).toEqual([]);
    expect(
      issues({ ...minimal, mcp: [{ name: "notes", url: "http://notes.example.com/mcp" }] }),
    ).toEqual(["mcp.0.url"]);
    expect(
      issues({ ...minimal, mcp: [{ name: "My Notes", url: "https://n.example.com" }] }),
    ).toEqual(["mcp.0.name"]);
    expect(issues({ ...minimal, mcp: [{ name: "erp", url: "https://n.example.com" }] })).toEqual([
      "mcp.0.name",
    ]);
    const twice = { name: "notes", url: "https://n.example.com/mcp" };
    expect(issues({ ...minimal, mcp: [twice, twice] })).toEqual(["mcp"]);
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

  it("rejects an empty match, and takes a project with only a name (logged by hand)", () => {
    expect(issues({ ...minimal, projects: [{ name: "Acme", match: {} }] })).toEqual([
      "projects.0.match",
    ]);
    expect(issues({ ...minimal, projects: [{ name: "Acme" }] })).toEqual([]);
  });

  it("writes short, verb-first descriptions unless told otherwise", () => {
    expect(configSchema.parse(minimal).descriptions).toEqual({
      format: "imperative",
      length: "short",
    });
    expect(issues({ ...minimal, descriptions: { length: "epic" } })).toEqual([
      "descriptions.length",
    ]);
  });

  it("takes an ignore rule with or without a match", () => {
    expect(issues({ ...minimal, projects: [{ name: "dotfiles", ignore: true }] })).toEqual([]);
    expect(
      issues({
        ...minimal,
        projects: [{ name: "Personal", ignore: true, match: { repo: "ada/blog" } }],
      }),
    ).toEqual([]);
  });
});

describe("durationMinutes", () => {
  it.each([
    ["15m", 15],
    ["1h", 60],
    ["1h30m", 90],
  ])("%s → %i", (s, m) => expect(durationMinutes(s)).toBe(m));
});
