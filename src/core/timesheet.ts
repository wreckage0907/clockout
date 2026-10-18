import { type Config, durationMinutes } from "../config/schema";
import { minutesBetween, roundedHours } from "./time";
import type { Block, Day, TimesheetRow } from "./types";

/** Blocks that go on the timesheet: confirmed and billable. */
export function countedBlocks(day: Day): Block[] {
  return day.blocks.filter((b) => b.confirmed && b.billable);
}

/** A block's hours, rounded to `round_to`. */
export function blockHours(b: Block, config: Config): number {
  return roundedHours(minutesBetween(b.start, b.end), durationMinutes(config.day.round_to));
}

/**
 * One row per project, task and description: blocks of the same work are one timesheet entry.
 * Minutes are summed first and rounded once, in order of first appearance.
 */
export function timesheetRows(day: Day, config: Config): TimesheetRow[] {
  const step = durationMinutes(config.day.round_to);
  const groups = new Map<string, { row: TimesheetRow; minutes: number }>();
  for (const b of countedBlocks(day)) {
    const key = JSON.stringify([b.project, b.task, b.summary]);
    const g = groups.get(key) ?? {
      row: { date: day.date, project: b.project, task: b.task, hours: 0, description: b.summary },
      minutes: 0,
    };
    g.minutes += minutesBetween(b.start, b.end);
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({ ...g.row, hours: roundedHours(g.minutes, step) }));
}

export interface DayTotals {
  hours: number;
  blocks: number;
  gaps: number;
  questions: number;
}

export function dayTotals(day: Day, config: Config): DayTotals {
  return {
    hours: timesheetRows(day, config).reduce((sum, r) => sum + r.hours, 0),
    blocks: countedBlocks(day).length,
    gaps: day.gaps.length,
    questions: day.questions.length,
  };
}
