import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import {
  aiSettingOpSchema,
  applySettings,
  describeSettings,
  type SettingOp,
} from "../../src/config/setting-ops";

const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
  sources: [{ type: "claude-code" }, { type: "github" }],
});
const projects = [
  { folder: "-Users-dev-work-acme-api", name: "acme-api" },
  { folder: "-Users-dev-code-personal", name: "personal" },
];
const withErp = {
  ...config,
  timesheet: { type: "next-pms" as const, url: "https://erp.example.com", map: [] },
};

describe("applySettings", () => {
  it("turns sources off and on", () => {
    const r = applySettings(config, [{ op: "source", source: "github", on: false }]);
    expect(r.errors).toEqual([]);
    expect(r.config.sources.map((s) => s.type)).toEqual(["claude-code"]);
  });

  it("turns on Pi and Codex sessions", () => {
    const r = applySettings(config, [
      { op: "source", source: "pi", on: true },
      { op: "source", source: "codex", on: true },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.config.sources.map((s) => s.type)).toEqual(["claude-code", "github", "pi", "codex"]);
    expect(
      describeSettings([
        { op: "source", source: "pi", on: true },
        { op: "source", source: "codex", on: false },
      ]),
    ).toEqual(["Read Pi sessions", "Stop reading Codex sessions"]);
  });

  it("leaves Claude Code projects out by name, and back in", () => {
    const out = applySettings(
      config,
      [{ op: "claude_projects", names: ["Personal"], on: false }],
      projects,
    );
    expect(out.config.sources[0]).toEqual({
      type: "claude-code",
      exclude: ["-Users-dev-code-personal"],
    });
    const back = applySettings(
      out.config,
      [{ op: "claude_projects", names: ["personal"], on: true }],
      projects,
    );
    expect(back.config.sources[0]).toEqual({ type: "claude-code" });
  });

  it("says so when a project name isn't on this machine", () => {
    const r = applySettings(
      config,
      [{ op: "claude_projects", names: ["nope"], on: false }],
      projects,
    );
    expect(r.errors).toEqual(["No Claude Code project called “nope”."]);
  });

  it("sets the day's numbers, keeping the ones not mentioned", () => {
    const r = applySettings(config, [{ op: "day", target: "7h30m" }]);
    expect(r.errors).toEqual([]);
    expect(r.config.day).toEqual({ ...config.day, target: "7h30m" });
  });

  it("validates like config.toml, so a bad value comes back as a readable error", () => {
    const r = applySettings(config, [
      { op: "day", working_hours: "9 to 6" },
      { op: "timezone", timezone: "Mars/Olympus" },
    ]);
    expect(r.errors).toEqual([
      "me.timezone: unknown time zone; use an IANA name like Asia/Kolkata",
      'day.working_hours: use "HH:MM-HH:MM", e.g. "09:30-18:30"',
    ]);
  });

  it("adds a project rule, replacing one with the same name and match", () => {
    const rule: SettingOp = { op: "project_rule", name: "Acme", repo: "acme/api" };
    const once = applySettings(config, [rule]).config;
    const twice = applySettings(once, [{ ...rule, task: "Backend" }]).config;
    expect(twice.projects).toEqual([
      { name: "Acme", task: "Backend", match: { repo: "acme/api" } },
    ]);
    expect(
      applySettings(twice, [{ op: "remove_project_rule", name: "acme" }]).config.projects,
    ).toEqual([]);
  });

  it("needs at least one thing for a project rule to match", () => {
    const r = applySettings(config, [{ op: "project_rule", name: "Acme" }]);
    expect(r.errors).toEqual([
      "projects.0.match: give at least one of repo, title, attendee_domain",
    ]);
  });

  it("names task defaults and the AI helper", () => {
    const r = applySettings(config, [
      { op: "task_names", meeting: "Calls" },
      { op: "ai", on: false },
    ]);
    expect(r.config.tasks).toEqual({ ...config.tasks, meeting: "Calls" });
    expect(r.config.ai.backend).toBe("none");
  });

  it("reads a private calendar link as an ICS source", () => {
    const url = "https://calendar.example.com/private-abc/basic.ics";
    const r = applySettings(config, [{ op: "calendar_feed", url }]);
    expect(r.config.sources.at(-1)).toEqual({ type: "calendar", method: "ics", url });
  });

  it("leaves sign-ins and unsettled ERP tasks to the caller", () => {
    const r = applySettings(withErp, [
      { op: "connect", service: "erp", url: "erp.example.com" },
      { op: "disconnect", service: "google" },
      { op: "erp_task", project: "acme/api", search: "hackathon" },
    ]);
    expect(r.config).toEqual(withErp);
    expect(r.effects).toEqual([
      { kind: "connect", service: "erp", url: "erp.example.com" },
      { kind: "disconnect", service: "google" },
      { kind: "pick_task", project: "acme/api", search: "hackathon" },
    ]);
  });

  it("maps an ERP task once it's been found, and needs an ERP for it", () => {
    const op: SettingOp = {
      op: "erp_task",
      project: "acme/api",
      search: "hackathon",
      erp_task: "TASK-1",
      label: "Hackathon",
    };
    expect(applySettings(withErp, [op]).config.timesheet?.map).toEqual([
      { project: "acme/api", erp_task: "TASK-1", label: "Hackathon" },
    ]);
    expect(applySettings(config, [op]).errors[0]).toMatch(/Connect your ERP first/);
  });
});

describe("the AI's settings schema", () => {
  it("has no way to set a calendar link or an ERP task id", () => {
    expect(
      aiSettingOpSchema.safeParse({ op: "calendar_feed", url: "https://x/a.ics" }).success,
    ).toBe(false);
    const parsed = aiSettingOpSchema.parse({
      op: "erp_task",
      project: "a",
      search: "b",
      erp_task: "TASK-9",
    });
    expect(parsed).not.toHaveProperty("erp_task");
  });
});

describe("describeSettings", () => {
  it("says each change in a line", () => {
    expect(
      describeSettings([
        { op: "day", target: "7h30m", round_to: "15m" },
        { op: "claude_projects", names: ["personal"], on: false },
        { op: "connect", service: "erp", url: "erp.example.com" },
        { op: "erp_task", project: "acme/api", search: "hackathon" },
      ]),
    ).toEqual([
      "daily target → 7h30m, round to 15m",
      "Leave out Claude Code project personal",
      "Sign in to your ERP at erp.example.com in your browser",
      "Pick the ERP task for acme/api (searching “hackathon”)",
    ]);
  });
});
