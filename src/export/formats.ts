import type { TimesheetRow } from "../core/types";

export const COLUMNS = ["Date", "Project", "Task", "Hours", "Description"] as const;

function cells(r: TimesheetRow): string[] {
  return [r.date, r.project, r.task, formatHours(r.hours), r.description];
}

export function formatHours(h: number): string {
  return h.toFixed(2);
}

/**
 * A spreadsheet runs a cell starting with = + - or @ as a formula, and meeting titles can come
 * from anyone: a leading ' keeps it text.
 */
function inert(v: string): string {
  return /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
}

/** RFC 4180: quote fields containing commas, quotes or newlines. */
export function toCsv(rows: TimesheetRow[]): string {
  const quote = (raw: string) => {
    const v = inert(raw);
    return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return `${[COLUMNS.map((c) => c.toLowerCase()), ...rows.map(cells)]
    .map((r) => r.map(quote).join(","))
    .join("\r\n")}\r\n`;
}

export function toMarkdown(rows: TimesheetRow[]): string {
  const esc = (v: string) => v.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
  const total = rows.reduce((s, r) => s + r.hours, 0);
  return [
    `| ${COLUMNS.join(" | ")} |`,
    "|---|---|---|---:|---|",
    ...rows.map((r) => `| ${cells(r).map(esc).join(" | ")} |`),
    `| | | **Total** | **${formatHours(total)}** | |`,
  ].join("\n");
}

/** Tab-separated, which pastes into spreadsheet and web-form grids cell by cell. */
export function toTsv(rows: TimesheetRow[]): string {
  return rows
    .map((r) =>
      cells(r)
        .map((c) => inert(c.replace(/[\t\r\n]/g, " ")))
        .join("\t"),
    )
    .join("\n");
}
