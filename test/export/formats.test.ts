import { describe, expect, it } from "vitest";
import type { TimesheetRow } from "../../src/core/types";
import { toCsv, toMarkdown, toTsv } from "../../src/export/formats";

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
    description: 'Say "hi" | standup',
  },
];

describe("timesheet formats", () => {
  it("writes RFC 4180 CSV with the five columns", () => {
    expect(toCsv(rows)).toBe(
      "date,project,task,hours,description\r\n" +
        '2026-10-16,acme/api,Development,2.25,"Fix auth, refresh"\r\n' +
        '2026-10-16,Meetings,Meetings,0.50,"Say ""hi"" | standup"\r\n',
    );
  });

  it("writes a Markdown table with a total", () => {
    const md = toMarkdown(rows).split("\n");
    expect(md[0]).toBe("| Date | Project | Task | Hours | Description |");
    expect(md[3]).toBe('| 2026-10-16 | Meetings | Meetings | 0.50 | Say "hi" \\| standup |');
    expect(md.at(-1)).toBe("| | | **Total** | **2.75** | |");
  });

  it("writes tab-separated rows for pasting into forms", () => {
    expect(toTsv(rows).split("\n")[0]).toBe(
      "2026-10-16\tacme/api\tDevelopment\t2.25\tFix auth, refresh",
    );
  });

  it("keeps a cell that looks like a formula as text in spreadsheets", () => {
    const evil = [{ ...rows[0], description: '=HYPERLINK("http://x")' } as TimesheetRow];
    expect(toCsv(evil).split("\r\n")[1]).toBe(
      `2026-10-16,acme/api,Development,2.25,"'=HYPERLINK(""http://x"")"`,
    );
    expect(toTsv(evil)).toMatch(/\t'=HYPERLINK/);
  });

  it("keeps a Markdown row on one line", () => {
    const multi = [{ ...rows[0], description: "one\r\ntwo" } as TimesheetRow];
    expect(toMarkdown(multi).split("\n")[2]).toBe(
      "| 2026-10-16 | acme/api | Development | 2.25 | one two |",
    );
  });
});
