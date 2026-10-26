import { styleText } from "node:util";
import type { Config } from "../config/schema";
import { cleanText } from "../core/text";
import { formatDuration, localTime, minutesBetween } from "../core/time";
import { dayTotals, timesheetRows } from "../core/timesheet";
import type { Day } from "../core/types";
import { formatHours } from "./formats";

type Style = Parameters<typeof styleText>[0];

/**
 * The day as a terminal table: blocks and gaps in time order, then the timesheet rows (which add
 * up to the header's total), questions and notes.
 */
export function renderDay(day: Day, config: Config, color = process.stdout.isTTY): string {
  const s = (style: Style, text: string) => (color ? styleText(style, text) : text);
  const tz = day.timezone;
  const t = (d: Date) => localTime(d, tz);
  const totals = dayTotals(day, config);
  const projectWidth = Math.min(24, Math.max(8, ...day.blocks.map((b) => b.project.length)));

  const lines: string[] = [];
  const weekday = new Date(`${day.date}T12:00:00Z`).toLocaleDateString("en", {
    weekday: "short",
    timeZone: "UTC",
  });
  lines.push(
    `${s("bold", "clockout")} · ${weekday} ${day.date} · ${tz}    ${s("bold", `${formatHours(totals.hours)}h`)}` +
      (totals.questions
        ? s("yellow", ` · ${totals.questions} question${totals.questions === 1 ? "" : "s"}`)
        : ""),
  );
  lines.push("");

  const rows = [
    ...day.blocks.map((b) => ({ at: b.start.getTime(), block: b, gap: undefined })),
    ...day.gaps.map((g) => ({ at: g.start.getTime(), block: undefined, gap: g })),
  ].sort((a, b) => a.at - b.at);

  for (const r of rows) {
    if (r.gap) {
      lines.push(
        s(
          "dim",
          `     ${t(r.gap.start)}–${t(r.gap.end)}  ${formatDuration(minutesBetween(r.gap.start, r.gap.end))}         ── gap ──`,
        ),
      );
      continue;
    }
    const b = r.block;
    if (!b) continue;
    const mark = !b.confirmed ? s("yellow", "?") : !b.billable ? s("dim", "–") : " ";
    const line = [
      `${mark}${b.id.padStart(4)}`,
      `${t(b.start)}–${t(b.end)}`,
      formatDuration(minutesBetween(b.start, b.end)),
      b.project.slice(0, projectWidth).padEnd(projectWidth),
      `${b.summary}${b.task !== config.tasks.work && b.task !== b.project ? s("dim", ` · ${b.task}`) : ""}`,
    ].join("  ");
    lines.push(b.confirmed && b.billable ? line : s("dim", line));
    // What a recorder said about a meeting: on screen, never in the sheet (ADR 0010).
    const note = b.evidence.find((a) => a.notes)?.notes;
    if (note) lines.push(s("dim", `        “${oneLine(note, 120)}”`));
  }

  const sheet = timesheetRows(day, config);
  if (sheet.length) {
    lines.push("", s("bold", "Timesheet"));
    for (const r of sheet) {
      lines.push(
        `  ${`${formatHours(r.hours)}h`.padStart(6)}  ${r.project.slice(0, projectWidth).padEnd(projectWidth)}  ${r.description}`,
      );
    }
  }
  if (day.questions.length) {
    lines.push("", s("yellow", "Questions"));
    for (const q of day.questions) lines.push(`  ${q.id}  ${q.text}`);
    // Printed days are read outside the app, where nothing else says how to answer.
    if (sheet.length)
      lines.push(
        s("dim", '  Answer in the app (clockout), or: clockout edit "the 12:15 gap was lunch"'),
      );
  }
  if (day.notes.length) {
    lines.push("", s("dim", "Notes"));
    for (const n of day.notes) lines.push(s("dim", `  ${n}`));
  }
  return lines.join("\n");
}

/** A recorder's summary on one short line: it can be several sentences and hold newlines. */
function oneLine(text: string, max: number): string {
  const one = cleanText(text);
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}
