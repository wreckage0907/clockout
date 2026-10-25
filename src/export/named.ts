import {
  type Config,
  DATE_TOKENS,
  EXPORT_FIELDS,
  type ExportField,
  type ExportFormat,
} from "../config/schema";
import { mappingFor } from "../core/push";
import { blockRows, timesheetRows } from "../core/timesheet";
import type { Day, TimesheetRow } from "../core/types";
import { inert, toCsv, toMarkdown, toTsv } from "./formats";

// Your own export formats from `[[exports]]` (ADR 0009): columns, headers, date and hours
// formats, text lines. Templates only fill in fields; nothing is evaluated.

type Column = NonNullable<ExportFormat["columns"]>[number];

/** A format to export or copy as: built in, or one of yours. */
export type ExportChoice =
  | { kind: "built-in"; name: "csv" | "tsv" | "md" | "json" }
  | { kind: "named"; format: ExportFormat };

const DEFAULT_COLUMNS: Column[] = ["date", "project", "task", "hours", "description"].map(
  (field) => ({ field: field as ExportField }),
);

/** The format called `name` (any case; "markdown" is md), or undefined. */
export function findExport(name: string, config: Config): ExportChoice | undefined {
  const n = name.toLowerCase();
  const builtIn = n === "markdown" ? "md" : n;
  if (builtIn === "csv" || builtIn === "tsv" || builtIn === "md" || builtIn === "json")
    return { kind: "built-in", name: builtIn };
  const format = config.exports.find((e) => e.name === n);
  return format ? { kind: "named", format } : undefined;
}

/** Every name `--format` and `/copy` take: the built-in ones, then yours. */
export function exportNames(config: Config): string[] {
  return ["csv", "md", "tsv", "json", ...config.exports.map((e) => e.name)];
}

/** What Ctrl+Y copies: your default export, or tab-separated rows to paste. */
export function copyDefault(config: Config): ExportChoice {
  const format = config.exports.find((e) => e.default);
  return format ? { kind: "named", format } : { kind: "built-in", name: "tsv" };
}

/** The day's rows for a format: merged unless the format asks for one row per block. */
export function rowsFor(choice: ExportChoice, day: Day, config: Config): TimesheetRow[] {
  return choice.kind === "named" && !choice.format.merge
    ? blockRows(day, config)
    : timesheetRows(day, config);
}

/** Rows as text in the chosen format. */
export function render(choice: ExportChoice, rows: TimesheetRow[], config: Config): string {
  if (choice.kind === "built-in") {
    switch (choice.name) {
      case "csv":
        return toCsv(rows);
      case "tsv":
        return `${toTsv(rows)}\n`;
      case "md":
        return `${toMarkdown(rows)}\n`;
      case "json":
        return `${JSON.stringify(
          rows.map(({ sendTo: _, ...r }) => r),
          null,
          2,
        )}\n`;
    }
  }
  return renderNamed(choice.format, rows, config);
}

/** Rows in one of your formats. */
export function renderNamed(format: ExportFormat, rows: TimesheetRow[], config: Config): string {
  const columns = format.columns ?? DEFAULT_COLUMNS;
  const header = (c: Column) => c.header ?? c.field;
  const cell = (r: TimesheetRow, c: Column) => fieldText(r, c, config);
  switch (format.type) {
    case "csv": {
      const quote = (raw: string) => {
        const v = inert(raw);
        return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
      };
      return `${[columns.map(header), ...rows.map((r) => columns.map((c) => cell(r, c)))]
        .map((line) => line.map(quote).join(","))
        .join("\r\n")}\r\n`;
    }
    case "tsv": {
      const clean = (v: string) => inert(v.replace(/[\t\r\n]/g, " "));
      // Rows to paste into a grid; a header line only when you named the columns.
      const head = columns.some((c) => c.header !== undefined) ? [columns.map(header)] : [];
      return `${[...head, ...rows.map((r) => columns.map((c) => cell(r, c)))]
        .map((line) => line.map(clean).join("\t"))
        .join("\n")}\n`;
    }
    case "markdown": {
      const esc = (v: string) => v.replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ");
      const lines = [
        `| ${columns.map((c) => esc(header(c))).join(" | ")} |`,
        `|${columns.map((c) => (c.field === "hours" ? "---:" : "---")).join("|")}|`,
        ...rows.map((r) => `| ${columns.map((c) => esc(cell(r, c))).join(" | ")} |`),
      ];
      const hours = columns.findIndex((c) => c.field === "hours");
      const total = rows.reduce((s, r) => s + r.hours, 0);
      const at = columns[hours];
      if (at && rows.length) {
        const cells = columns.map(() => "");
        cells[hours] = `**${formatHoursAs(total, at)}**`;
        if (hours > 0) cells[hours - 1] = "**Total**";
        lines.push(`| ${cells.join(" | ")} |`);
      }
      return `${lines.join("\n")}\n`;
    }
    case "json":
      return `${JSON.stringify(
        rows.map((r) =>
          Object.fromEntries(columns.map((c) => [header(c), jsonValue(r, c, config)])),
        ),
        null,
        2,
      )}\n`;
    case "text": {
      // Formats come from the columns when a field has one.
      const byField = new Map(columns.map((c) => [c.field, c]));
      const fill = (r: TimesheetRow) =>
        (format.line ?? "").replace(/\{([^{}]*)\}/g, (all, f: string) =>
          isField(f) ? cell(r, byField.get(f) ?? { field: f }).replace(/[\r\n]+/g, " ") : all,
        );
      return `${rows.map(fill).join("\n")}\n`;
    }
  }
}

function isField(f: string): f is ExportField {
  return (EXPORT_FIELDS as readonly string[]).includes(f);
}

function fieldText(r: TimesheetRow, c: Column, config: Config): string {
  switch (c.field) {
    case "date":
      return c.format ? formatDate(r.date, c.format) : r.date;
    case "hours":
      return formatHoursAs(r.hours, c);
    case "erp_task":
      return erpTask(r, config)?.erp_task ?? "";
    case "erp_task_name": {
      const t = erpTask(r, config);
      return t?.label ?? t?.erp_task ?? "";
    }
    default:
      return r[c.field];
  }
}

/** Hours as decimal and minutes stay numbers in JSON; everything else is text. */
function jsonValue(r: TimesheetRow, c: Column, config: Config): string | number {
  if (c.field === "hours" && (c.format ?? "decimal") === "decimal")
    return Number(r.hours.toFixed(c.decimals ?? 2));
  if (c.field === "hours" && c.format === "minutes") return Math.round(r.hours * 60);
  return fieldText(r, c, config);
}

function erpTask(
  r: TimesheetRow,
  config: Config,
): { erp_task: string; label?: string } | undefined {
  if (r.sendTo) return { erp_task: r.sendTo.task, label: r.sendTo.label };
  return config.timesheet ? mappingFor(r, config.timesheet.map) : undefined;
}

/** 1.25 → "1.25", "1:15", "75" or "1h 15m". */
export function formatHoursAs(hours: number, c: Pick<Column, "format" | "decimals">): string {
  const minutes = Math.round(hours * 60);
  switch (c.format ?? "decimal") {
    case "h:mm":
      return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`;
    case "minutes":
      return String(minutes);
    case "hm": {
      const h = Math.floor(minutes / 60);
      const m = minutes % 60;
      return [h ? `${h}h` : "", m || !h ? `${m}m` : ""].filter(Boolean).join(" ");
    }
    default:
      return hours.toFixed(c.decimals ?? 2);
  }
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "2026-10-16" with "dd/MM/yyyy" → "16/10/2026". The date is a calendar day; no time zone. */
export function formatDate(date: string, pattern: string): string {
  const [y = 0, m = 1, d = 1] = date.split("-").map(Number);
  const weekday = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()] ?? "";
  const month = MONTHS[m - 1] ?? "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return pattern.replace(DATE_TOKENS, (t) => {
    switch (t) {
      case "yyyy":
        return String(y);
      case "yy":
        return pad(y % 100);
      case "MMMM":
        return month;
      case "MMM":
        return month.slice(0, 3);
      case "MM":
        return pad(m);
      case "M":
        return String(m);
      case "dd":
        return pad(d);
      case "d":
        return String(d);
      case "EEEE":
        return weekday;
      default:
        return weekday.slice(0, 3);
    }
  });
}
