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

/** One row per counted block. */
export function timesheetRows(day: Day, config: Config): TimesheetRow[] {
  return countedBlocks(day).map((b) => ({
    date: day.date,
    project: b.project,
    task: b.task,
    hours: blockHours(b, config),
    description: b.summary,
  }));
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
