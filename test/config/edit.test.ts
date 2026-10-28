import { stringify } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  clockMinutes,
  clockText,
  durationText,
  withAi,
  withClaudeExclude,
  withDay,
  withoutTaskMapping,
  withSource,
  withTaskMapping,
} from "../../src/config/edit";
import { parseConfig } from "../../src/config/load";
import { type Config, configSchema } from "../../src/config/schema";

const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
  sources: [{ type: "claude-code" }, { type: "github" }],
});

describe("config edits from setup", () => {
  it("forgets one ERP task mapping and keeps the others", () => {
    let c: Config = {
      ...config,
      timesheet: { type: "http", url: "https://pms.example.com", map: [] },
    };
    c = withTaskMapping(c, { project: "acme/api", erp_task: "T-1" });
    c = withTaskMapping(c, { project: "acme/api", task: "Code Review", erp_task: "T-2" });
    const out = withoutTaskMapping(c, { project: "acme/api" });
    expect(out.timesheet?.map).toEqual([
      { project: "acme/api", task: "Code Review", erp_task: "T-2" },
    ]);
    expect(withoutTaskMapping(config, { project: "acme/api" })).toBe(config);
  });

  it("turns sources on once and off entirely", () => {
    const on = withSource(config, { type: "google-calendar", calendars: ["primary"] }, true);
    expect(on.sources.map((s) => s.type)).toEqual(["claude-code", "github", "google-calendar"]);
    expect(
      withSource(on, { type: "google-calendar", calendars: ["primary"] }, true).sources,
    ).toHaveLength(3);
    expect(withSource(on, { type: "github" }, false).sources.map((s) => s.type)).toEqual([
      "claude-code",
      "google-calendar",
    ]);
  });

  it("writes Claude Code excludes, and drops the key when none are left", () => {
    const out = withClaudeExclude(config, ["-Users-dev-personal"]);
    expect(out.sources[0]).toEqual({ type: "claude-code", exclude: ["-Users-dev-personal"] });
    const back = withClaudeExclude(out, []);
    expect(back.sources[0]).toEqual({ type: "claude-code" });
    // Round-trips through TOML, which has no undefined.
    expect(parseConfig(stringify(back)).sources[0]).toEqual({ type: "claude-code" });
  });

  it("sets the day and the AI helper", () => {
    expect(withDay(config, { target: durationText(450) }).day.target).toBe("7h30m");
    expect(withAi(config, "none").ai.backend).toBe("none");
  });

  it("formats durations and clock times the way config.toml writes them", () => {
    expect(durationText(480)).toBe("8h");
    expect(durationText(45)).toBe("45m");
    expect(clockMinutes("09:30")).toBe(570);
    expect(clockText(570)).toBe("09:30");
  });
});
