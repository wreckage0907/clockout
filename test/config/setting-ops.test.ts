import { stringify } from "smol-toml";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../src/config/load";
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

  it("turns on opencode and Antigravity sessions", () => {
    const ops = [
      { op: "source", source: "opencode", on: true },
      { op: "source", source: "antigravity", on: true },
    ] as const;
    const r = applySettings(config, [...ops]);
    expect(r.errors).toEqual([]);
    expect(r.config.sources.map((s) => s.type)).toEqual([
      "claude-code",
      "github",
      "opencode",
      "antigravity",
    ]);
    expect(describeSettings([...ops])).toEqual([
      "Read opencode sessions",
      "Read Antigravity conversations",
    ]);
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

  it("adds a project by name alone, or one to leave out", () => {
    const add: SettingOp = { op: "project_rule", name: "Acme Website", task: "Support" };
    const r = applySettings(config, [add]);
    expect(r.errors).toEqual([]);
    expect(r.config.projects).toEqual([{ name: "Acme Website", task: "Support" }]);
    expect(describeSettings([add])).toEqual(["Add the project Acme Website (Support)"]);
    const ignore: SettingOp = { op: "project_rule", name: "dotfiles", ignore: true };
    const left = applySettings(config, [ignore]);
    expect(left.errors).toEqual([]);
    expect(left.config.projects).toEqual([{ name: "dotfiles", ignore: true }]);
    expect(describeSettings([ignore])).toEqual(["Leave out dotfiles, work and meetings"]);
    expect(
      describeSettings([{ op: "project_rule", name: "Personal", repo: "ada/blog", ignore: true }]),
    ).toEqual(["Leave out repo ada/blog, work and meetings"]);
  });

  it("changes how descriptions are written, and takes your own words back out", () => {
    const op: SettingOp = {
      op: "descriptions",
      format: "past",
      length: "medium",
      instructions: "Put the ticket key first",
    };
    const r = applySettings(config, [op]);
    expect(r.errors).toEqual([]);
    expect(r.config.descriptions).toEqual({
      format: "past",
      length: "medium",
      instructions: "Put the ticket key first",
    });
    expect(describeSettings([op])).toEqual([
      "Descriptions: start with “Fixed …”, medium length, follow “Put the ticket key first”",
    ]);
    const cleared = applySettings(r.config, [
      { op: "descriptions", instructions: "", examples: [] },
    ]);
    expect(cleared.config.descriptions).toEqual({ format: "past", length: "medium" });
    expect(
      applySettings(config, [{ op: "descriptions", examples: ["Fixed the login loop"] }]).config
        .descriptions.examples,
    ).toEqual(["Fixed the login loop"]);
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

describe("standup style by chat", () => {
  it("changes only what was said, and takes your own words back out", () => {
    const r = applySettings(config, [
      {
        op: "standup",
        format: "prose",
        instructions: "Lead with tickets",
        examples: ["Y: a. T: b."],
      },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.config.standup).toEqual({
      format: "prose",
      length: "short",
      instructions: "Lead with tickets",
      examples: ["Y: a. T: b."],
    });
    const back = applySettings(r.config, [{ op: "standup", instructions: "", examples: [] }]);
    expect(back.config.standup).toEqual({ format: "prose", length: "short" });
    expect(
      describeSettings([
        { op: "standup", format: "bullets", length: "medium" },
        { op: "standup", instructions: "Lead with tickets" },
        { op: "standup" },
      ]),
    ).toEqual([
      "Standup: bullet points, medium length",
      "Standup: follow “Lead with tickets”",
      "No change to the standup",
    ]);
  });
});

describe("export destinations by chat", () => {
  const notion = { mcp: "notion", tool: "append_block", arguments: { content: "{text}" } };
  const propose = (to: unknown): SettingOp => ({
    op: "export_format",
    name: "daily-note",
    type: "markdown",
    to: to as never,
  });
  const base = {
    ...config,
    mcp: [{ name: "notion", url: "https://mcp.example.com/mcp" }],
    exports: [{ name: "daily-note", type: "markdown" as const, merge: true, to: notion }],
  };
  const scheduled = {
    ...base,
    schedule: [
      {
        name: "evening",
        at: "18:30",
        day: "today" as const,
        kind: "export" as const,
        format: "daily-note",
        allow_open: false,
      },
    ],
  };

  it("shows where the export goes whenever the proposal sets it", () => {
    expect(describeSettings([propose(notion)])).toEqual([
      'Export daily-note: Markdown · sent to notion · append_block (content="{text}")',
    ]);
    const elsewhere = { mcp: "slack", tool: "post", arguments: { c: "{text}", x: "other" } };
    expect(describeSettings([propose(elsewhere)])[0]).toContain(
      'sent to slack · post (c="{text}", x="other")',
    );
  });

  it("keeps the destination it had when the update leaves it out", () => {
    const r = applySettings(base, [propose(undefined)]);
    expect(r.errors).toEqual([]);
    expect(r.config.exports[0]?.to).toEqual(notion);
    const files = {
      ...base,
      exports: [
        {
          name: "daily-note",
          type: "markdown" as const,
          merge: true,
          to: { file: "~/Vault/{date}.md", append: true },
        },
      ],
    };
    expect(applySettings(files, [propose(undefined)]).config.exports[0]?.to).toEqual({
      file: "~/Vault/{date}.md",
      append: true,
    });
  });

  it("changes the destination of an export no job uses", () => {
    const r = applySettings(base, [propose({ mcp: "notion", tool: "other" })]);
    expect(r.errors).toEqual([]);
    expect(r.config.exports[0]?.to).toMatchObject({ tool: "other" });
  });

  it("refuses to repoint an export a scheduled job uses", () => {
    const r = applySettings(scheduled, [propose({ mcp: "notion", tool: "other" })]);
    expect(r.errors).toEqual([
      "The export “daily-note” is used by a scheduled job, so its destination can't be changed from here. Change it in config.toml.",
    ]);
    expect(r.config.exports[0]?.to).toEqual(notion);
  });

  it("refuses to give a scheduled export a destination it had none of", () => {
    const none = {
      ...scheduled,
      exports: [{ name: "daily-note", type: "markdown" as const, merge: true }],
    };
    const r = applySettings(none, [propose(notion)]);
    expect(r.errors).toHaveLength(1);
    expect(r.config.exports[0]).not.toHaveProperty("to");
  });

  it("lets a scheduled export be updated when its destination is unchanged or left out", () => {
    expect(applySettings(scheduled, [propose(notion)]).errors).toEqual([]);
    expect(applySettings(scheduled, [propose(undefined)]).errors).toEqual([]);
    expect(applySettings(scheduled, [propose(undefined)]).config.exports[0]?.to).toEqual(notion);
  });
});

describe("project rule title patterns", () => {
  it("refuses a title that can backtrack without end", () => {
    const r = applySettings(config, [{ op: "project_rule", name: "Sync", title: "(a+)+$" }]);
    expect(r.errors).toEqual([
      "projects.0.match.title: the title pattern has a repeat inside a repeat, which can hang the app",
    ]);
  });

  it("refuses a very long title pattern, and takes an ordinary one", () => {
    expect(
      applySettings(config, [{ op: "project_rule", name: "Sync", title: "a".repeat(201) }]).errors,
    ).toHaveLength(1);
    expect(
      applySettings(config, [{ op: "project_rule", name: "Sync", title: "^(daily|weekly) sync" }])
        .errors,
    ).toEqual([]);
  });
});

describe("export formats by chat", () => {
  const harvest: SettingOp = {
    op: "export_format",
    name: "Harvest",
    type: "csv",
    columns: [
      { field: "date", header: "Date", format: "dd/MM/yyyy" },
      { field: "hours", header: "Time", format: "h:mm" },
      { field: "description", header: "Notes" },
    ],
  };

  it("adds one, named in lowercase, merged by default", () => {
    const r = applySettings(config, [harvest]);
    expect(r.errors).toEqual([]);
    expect(r.config.exports).toEqual([
      {
        name: "harvest",
        type: "csv",
        merge: true,
        columns: [
          { field: "date", header: "Date", format: "dd/MM/yyyy" },
          { field: "hours", header: "Time", format: "h:mm" },
          { field: "description", header: "Notes" },
        ],
      },
    ]);
  });

  it("saves to config.toml and reads back the same", () => {
    const r = applySettings(config, [harvest, { op: "export_format", name: "plain", type: "tsv" }]);
    expect(r.config.exports[1]).toEqual({ name: "plain", type: "tsv", merge: true });
    const text = stringify(r.config);
    expect(text).toContain("[[exports]]");
    expect(parseConfig(text).exports).toEqual(r.config.exports);
  });

  it("replaces one by name, and a new default takes over", () => {
    const first = applySettings(config, [
      harvest,
      {
        op: "export_format",
        name: "slack",
        type: "text",
        line: "{project}: {description}",
        default: true,
      },
    ]).config;
    const r = applySettings(first, [{ ...harvest, default: true } as SettingOp]);
    expect(r.errors).toEqual([]);
    expect(r.config.exports.map((e) => [e.name, e.default ?? false])).toEqual([
      ["slack", false],
      ["harvest", true],
    ]);
    expect(r.config.exports[0]).not.toHaveProperty("default");
  });

  it("checks a format like config.toml", () => {
    const r = applySettings(config, [
      { op: "export_format", name: "csv", type: "text", line: "{client}" },
    ]);
    expect(r.errors).toEqual([
      "exports.0.name: csv, tsv, md, markdown, json are built in; choose another name",
      "exports.0.line: {client} isn't a field; use {date} {project} {task} {hours} {description} {erp_task} {erp_task_name}",
    ]);
  });

  it("sets what Ctrl+Y copies, and removes one", () => {
    const added = applySettings(config, [harvest]).config;
    expect(
      applySettings(added, [{ op: "copy_default", name: "harvest" }]).config.exports[0]?.default,
    ).toBe(true);
    expect(applySettings(added, [{ op: "copy_default", name: "md" }]).errors).toEqual([
      "There's no export called “md”. Add one first (built-in formats can't be the default).",
    ]);
    expect(applySettings(added, [{ op: "remove_export", name: "Harvest" }]).config.exports).toEqual(
      [],
    );
    expect(applySettings(added, [{ op: "remove_export", name: "jira" }]).errors).toEqual([
      "There's no export called “jira”.",
    ]);
  });

  it("says each change in a line", () => {
    expect(
      describeSettings([
        harvest,
        {
          op: "export_format",
          name: "slack",
          type: "text",
          line: "{project}: {description}",
          merge: false,
        },
        { op: "copy_default", name: "harvest" },
        { op: "copy_default", name: "" },
        { op: "remove_export", name: "slack" },
      ]),
    ).toEqual([
      "Export harvest: CSV with Date (dd/MM/yyyy), Time (h:mm), Notes",
      "Export slack: lines like “{project}: {description}” · one row per block",
      "Ctrl+Y copies as harvest",
      "Ctrl+Y copies rows to paste",
      "Remove the export slack",
    ]);
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
