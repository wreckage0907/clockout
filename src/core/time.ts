import { TZDate } from "@date-fns/tz";
import type { DateRange } from "./types";

export const MINUTE = 60_000;

/** "YYYY-MM-DD" → the UTC instants of local midnight to the next local midnight in `tz`. */
export function dayRange(date: string, tz: string): DateRange {
  const [y, m, d] = parseDate(date);
  return {
    from: new Date(new TZDate(y, m - 1, d, tz).getTime()),
    to: new Date(new TZDate(y, m - 1, d + 1, tz).getTime()),
  };
}

/** Local "HH:MM" on `date` in `tz` → UTC instant. */
export function atLocalTime(date: string, hhmm: string, tz: string): Date {
  const [y, m, d] = parseDate(date);
  const [hh, mm] = hhmm.split(":").map(Number) as [number, number];
  return new Date(new TZDate(y, m - 1, d, hh, mm, tz).getTime());
}

/** UTC instant → local "HH:MM" in `tz`. */
export function localTime(at: Date, tz: string): string {
  const t = new TZDate(at.getTime(), tz);
  return `${pad(t.getHours())}:${pad(t.getMinutes())}`;
}

/** UTC instant → local "YYYY-MM-DD" in `tz`. */
export function localDate(at: Date, tz: string): string {
  const t = new TZDate(at.getTime(), tz);
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

/** "YYYY-MM-DD" plus `days` (may be negative). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = parseDate(date);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / MINUTE;
}

/** Hours rounded to the nearest `step` minutes; anything above zero counts as at least one step. */
export function roundedHours(minutes: number, step: number): number {
  if (minutes <= 0) return 0;
  return (Math.max(1, Math.round(minutes / step)) * step) / 60;
}

/** "1h35", "0h50" */
export function formatDuration(minutes: number): string {
  const m = Math.round(minutes);
  return `${Math.floor(m / 60)}h${pad(m % 60)}`;
}

export function isDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

function parseDate(date: string): [number, number, number] {
  if (!isDate(date)) throw new Error(`invalid date "${date}"; use YYYY-MM-DD`);
  return date.split("-").map(Number) as [number, number, number];
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}
