import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { addTimeProjects, resolveProject } from "../../src/core/projects";
import type { Activity, Block, Day } from "../../src/core/types";

describe("title rules", () => {
  const meeting = (title: string): Activity => ({
    source: "calendar",
    kind: "meeting",
    actor: "human",
    start: new Date("2026-10-16T10:00:00Z"),
    end: new Date("2026-10-16T10:30:00Z"),
    title,
  });

  it("matches a title", () => {
    const rules = [{ name: "Sync", match: { title: "standup" } }];
    expect(resolveProject(meeting("Daily standup"), rules)).toBe("Sync");
  });

  it("never runs a pattern that can backtrack without end", () => {
    const started = Date.now();
    const project = resolveProject(meeting(`${"a".repeat(40)}!`), [
      { name: "Evil", match: { title: "(a+)+$" } },
    ]);
    expect(project).toBe("Meetings");
    expect(Date.now() - started).toBeLessThan(500);
  });
});

const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "UTC" },
  projects: [
    { name: "Internal Tools" },
    { name: "Acme Website", match: { repo: "acme/web" } },
    { name: "dotfiles", ignore: true },
  ],
  timesheet: {
    type: "next-pms",
    url: "https://erp.example.com",
    map: [{ project: "acme/api", erp_task: "TASK-1" }],
  },
});

const block = (project: string, billable = true): Block => ({
  id: project,
  start: new Date("2026-10-16T10:00:00Z"),
  end: new Date("2026-10-16T11:00:00Z"),
  project,
  task: "Development",
  summary: "x",
  kind: "work",
  billable,
  confirmed: true,
  evidence: [],
});
const day: Day = {
  date: "2026-10-16",
  timezone: "UTC",
  blocks: [block("dev-example/clockout"), block("Break", false)],
  gaps: [],
  questions: [],
  notes: [],
};

describe("addTimeProjects", () => {
  it("offers the day's projects, then config's, ERP-mapped, recent days', then the ERP's", () => {
    const got = addTimeProjects(day, config, {
      recent: ["Side Gig", "internal tools", "dotfiles", "Break"],
      erp: ["Acme Internal", "Side Gig"],
    });
    expect(got).toEqual({
      local: ["dev-example/clockout", "Internal Tools", "Acme Website", "acme/api", "Side Gig"],
      erp: ["Acme Internal"],
    });
  });
});
