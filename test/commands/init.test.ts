import { describe, expect, it } from "vitest";
import { buildConfig, type Detections, parseEmails } from "../../src/commands/init";
import { configSchema } from "../../src/config/schema";

const answers = {
  name: "Dev",
  emails: ["dev@example.com"],
  timezone: "Asia/Kolkata",
  workingHours: "10:00-19:00",
  ai: "auto" as const,
};
const everything: Detections = {
  claudeCode: { summary: "3 projects" },
  pi: { summary: "2 projects" },
  codex: { summary: "5 sessions" },
  opencode: { summary: "4 sessions" },
  antigravity: { summary: "2 conversations" },
  github: { summary: "logged in with the gh CLI" },
  helpers: [{ name: "Claude Code", version: "2.1.302" }],
};

describe("buildConfig", () => {
  it("adds a source for each detected tool and the calendar URL", () => {
    const c = buildConfig({ ...answers, icsUrl: "https://calendar.example/basic.ics" }, everything);
    expect(c.sources).toEqual([
      { type: "claude-code" },
      { type: "pi" },
      { type: "codex" },
      { type: "opencode" },
      { type: "antigravity" },
      { type: "github" },
      { type: "calendar", method: "ics", url: "https://calendar.example/basic.ics" },
    ]);
    expect(configSchema.safeParse(c).success).toBe(true);
  });

  it("leaves out tools that weren't found and a skipped calendar", () => {
    const c = buildConfig(answers, {
      claudeCode: null,
      pi: null,
      codex: null,
      opencode: null,
      antigravity: null,
      github: null,
      helpers: [],
    });
    expect(c.sources).toEqual([]);
    expect(configSchema.safeParse(c).success).toBe(true);
  });

  it("keeps the user's working hours", () => {
    expect(buildConfig(answers, everything).day?.working_hours).toBe("10:00-19:00");
  });
});

describe("parseEmails", () => {
  it("splits on commas and spaces", () => {
    expect(parseEmails(" a@x.dev, b@y.dev  c@z.dev ")).toEqual(["a@x.dev", "b@y.dev", "c@z.dev"]);
  });
});
