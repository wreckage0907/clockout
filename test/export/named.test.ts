import { describe, expect, it } from "vitest";
import { type Config, type ConfigInput, configSchema } from "../../src/config/schema";
import { applyEdits } from "../../src/core/edits";
import { countedBlocks, timesheetRows } from "../../src/core/timesheet";
import type { TimesheetRow } from "../../src/core/types";
import {
  copyDefault,
  exportNames,
  findExport,
  formatDate,
  formatHoursAs,
  render,
  rowsFor,
} from "../../src/export/named";
import { config as fixtureConfig, fixtureDay } from "../helpers/fake-app";

const me = { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" };
const withExports = (exports: ConfigInput["exports"], extra: Partial<ConfigInput> = {}) =>
  configSchema.parse({ me, exports, ...extra });
const problems = (exports: unknown) => {
  const r = configSchema.safeParse({ me, exports });
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

const rows: TimesheetRow[] = [
  {
    date: "2026-10-16",
    project: "acme/api",
    task: "Development",
    hours: 2.25,
    description: "Fix auth, refresh",
  },
  {
    date: "2026-10-16",
    project: "Meetings",
    task: "Meetings",
    hours: 0.5,
    description: '=HYPERLINK("x") | standup',
  },
];

const harvest = {
  name: "harvest",
  type: "csv" as const,
  columns: [
    { field: "date" as const, header: "Date", format: "dd/MM/yyyy" },
    { field: "project" as const, header: "Client project" },
    { field: "hours" as const, header: "Time", format: "h:mm" },
    { field: "description" as const, header: "Notes" },
  ],
};

const named = (config: Config, name: string) => {
  const choice = findExport(name, config);
  if (!choice) throw new Error(`no export ${name}`);
  return choice;
};

describe("[[exports]] in config", () => {
  it("takes named formats with columns, merge on by default", () => {
    const config = withExports([harvest]);
    expect(config.exports[0]?.merge).toBe(true);
    expect(exportNames(config)).toEqual(["csv", "md", "tsv", "json", "harvest"]);
  });

  it("refuses built-in names, repeated names and a second default", () => {
    expect(problems([{ name: "csv", type: "csv" }])).toEqual([
      "csv, tsv, md, markdown, json are built in; choose another name",
    ]);
    expect(
      problems([
        { name: "a", type: "csv" },
        { name: "a", type: "tsv" },
      ]),
    ).toEqual(["each export needs its own name"]);
    expect(
      problems([
        { name: "a", type: "csv", default: true },
        { name: "b", type: "tsv", default: true },
      ]),
    ).toEqual(["only one export can be the default"]);
  });

  it("checks formats: dates as patterns, hours from a fixed list, nothing else", () => {
    expect(
      problems([{ name: "a", type: "csv", columns: [{ field: "hours", format: "hh" }] }]),
    ).toEqual(["hours are decimal, h:mm, minutes, hm"]);
    expect(
      problems([{ name: "a", type: "csv", columns: [{ field: "date", format: "iso" }] }]),
    ).toEqual(['use a date pattern like "dd/MM/yyyy" or "yyyy-MM-dd"']);
    expect(
      problems([{ name: "a", type: "csv", columns: [{ field: "project", format: "upper" }] }]),
    ).toEqual(["only dates and hours have a format"]);
    expect(
      problems([
        { name: "a", type: "csv", columns: [{ field: "hours", format: "h:mm", decimals: 1 }] },
      ]),
    ).toEqual(["decimals is only for hours as decimal"]);
    expect(problems([{ name: "a", type: "csv", columns: [{ field: "client" }] }])).toHaveLength(1);
  });

  it("needs a line for text, with known fields only, and no line elsewhere", () => {
    expect(problems([{ name: "slack", type: "text" }])).toEqual([
      'a text export needs a line, e.g. "{project}: {description} ({hours})"',
    ]);
    expect(problems([{ name: "slack", type: "text", line: "{project} {client}" }])).toEqual([
      "{client} isn't a field; use {date} {project} {task} {hours} {description} {erp_task} {erp_task_name}",
    ]);
    expect(problems([{ name: "a", type: "csv", line: "{project}" }])).toEqual([
      "line is only for text exports",
    ]);
  });
});

describe("finding a format", () => {
  const config = withExports([harvest, { name: "notes", type: "markdown", default: true }]);

  it("finds built-in ones in any case, markdown as md, and yours by name", () => {
    expect(findExport("CSV", config)).toEqual({ kind: "built-in", name: "csv" });
    expect(findExport("markdown", config)).toEqual({ kind: "built-in", name: "md" });
    expect(findExport("Harvest", config)).toMatchObject({
      kind: "named",
      format: { name: "harvest" },
    });
    expect(findExport("xml", config)).toBeUndefined();
  });

  it("copies as your default, or rows to paste without one", () => {
    expect(copyDefault(config)).toMatchObject({ kind: "named", format: { name: "notes" } });
    expect(copyDefault(withExports([harvest]))).toEqual({ kind: "built-in", name: "tsv" });
  });
});

describe("your own formats", () => {
  it("writes CSV with your headers, date pattern and h:mm, formulas kept as text", () => {
    const config = withExports([harvest]);
    expect(render(named(config, "harvest"), rows, config)).toBe(
      "Date,Client project,Time,Notes\r\n" +
        '16/10/2026,acme/api,2:15,"Fix auth, refresh"\r\n' +
        `16/10/2026,Meetings,0:30,"'=HYPERLINK(""x"") | standup"\r\n`,
    );
  });

  it("writes TSV without a header line unless you named the columns", () => {
    const config = withExports([
      {
        name: "grid",
        type: "tsv",
        columns: [{ field: "hours", format: "minutes" }, { field: "project" }],
      },
      { name: "titled", type: "tsv", columns: [{ field: "project", header: "Project" }] },
    ]);
    expect(render(named(config, "grid"), rows, config)).toBe("135\tacme/api\n30\tMeetings\n");
    expect(render(named(config, "titled"), rows, config)).toBe("Project\nacme/api\nMeetings\n");
  });

  it("writes a Markdown table with the total under the hours", () => {
    const config = withExports([
      {
        name: "notes",
        type: "markdown",
        columns: [
          { field: "project", header: "What" },
          { field: "hours", header: "Time", format: "hm" },
        ],
      },
    ]);
    expect(render(named(config, "notes"), rows, config)).toBe(
      "| What | Time |\n|---|---:|\n| acme/api | 2h 15m |\n| Meetings | 30m |\n| **Total** | **2h 45m** |\n",
    );
  });

  it("shows remote images and HTML in a custom Markdown export as text", () => {
    const config = withExports([{ name: "notes", type: "markdown" }]);
    const evil = [
      { ...rows[0], description: "![](https://tracker.example/x.png) <script>x</script>" },
    ] as TimesheetRow[];
    const out = render(named(config, "notes"), evil, config);
    expect(out).not.toMatch(/(^|[^\\])!\[/);
    expect(out).not.toContain("<script>");
  });

  it("writes JSON keyed by header, hours as numbers when decimal or minutes", () => {
    const config = withExports([
      {
        name: "api",
        type: "json",
        columns: [
          { field: "date", header: "day", format: "yyyyMMdd" },
          { field: "hours", decimals: 1 },
          { field: "hours", header: "mins", format: "minutes" },
        ],
      },
    ]);
    expect(JSON.parse(render(named(config, "api"), rows, config))).toEqual([
      { day: "20261016", hours: 2.3, mins: 135 },
      { day: "20261016", hours: 0.5, mins: 30 },
    ]);
  });

  it("writes text lines from a template, with formats from the columns", () => {
    const config = withExports([
      {
        name: "slack",
        type: "text",
        line: "• {project}: {description} ({hours})",
        columns: [{ field: "hours", format: "hm" }],
      },
    ]);
    const multi = [{ ...rows[0], description: "one\ntwo" } as TimesheetRow];
    expect(render(named(config, "slack"), multi, config)).toBe("• acme/api: one two (2h 15m)\n");
  });

  it("fills in the ERP task: the row's own pick, else its project's mapping", () => {
    const config = withExports(
      [
        {
          name: "erp",
          type: "csv",
          columns: [{ field: "project" }, { field: "erp_task" }, { field: "erp_task_name" }],
        },
      ],
      {
        timesheet: {
          type: "http",
          url: "https://erp.example.com",
          map: [{ project: "acme/api", erp_task: "TASK-1", label: "API work" }],
        },
      },
    );
    const picked = [...rows, { ...rows[1], sendTo: { task: "TASK-2" } } as TimesheetRow];
    expect(render(named(config, "erp"), picked, config).split("\r\n")).toEqual([
      "project,erp_task,erp_task_name",
      "acme/api,TASK-1,API work",
      "Meetings,,",
      "Meetings,TASK-2,TASK-2",
      "",
    ]);
  });

  it("gives one row per block of time when merge is off", () => {
    const config = {
      ...fixtureConfig,
      exports: withExports([{ name: "each", type: "csv", merge: false }]).exports,
    };
    const split = applyEdits(fixtureDay, [{ op: "split", id: "b2", at: "11:00" }], config).day;
    const each = rowsFor(named(config, "each"), split, config);
    const merged = rowsFor(named(config, "csv"), split, config);
    expect(each).toHaveLength(countedBlocks(split).length);
    expect(merged).toEqual(timesheetRows(split, config));
    expect(each.length).toBeGreaterThan(merged.length);
  });
});

describe("formats", () => {
  it("writes dates from a pattern", () => {
    expect(formatDate("2026-10-16", "dd/MM/yyyy")).toBe("16/10/2026");
    expect(formatDate("2026-03-05", "M/d/yy")).toBe("3/5/26");
    expect(formatDate("2026-10-16", "EEE d MMM")).toBe("Fri 16 Oct");
    expect(formatDate("2026-10-16", "EEEE, MMMM d")).toBe("Friday, October 16");
  });

  it("writes hours as decimal, h:mm, minutes or hm", () => {
    expect(formatHoursAs(1.25, {})).toBe("1.25");
    expect(formatHoursAs(1.25, { decimals: 1 })).toBe("1.3");
    expect(formatHoursAs(1.25, { format: "h:mm" })).toBe("1:15");
    expect(formatHoursAs(1.25, { format: "minutes" })).toBe("75");
    expect(formatHoursAs(1.25, { format: "hm" })).toBe("1h 15m");
    expect(formatHoursAs(2, { format: "hm" })).toBe("2h");
    expect(formatHoursAs(0, { format: "hm" })).toBe("0m");
  });
});
