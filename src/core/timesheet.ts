import { type Config, durationMinutes } from "../config/schema";
import { minutesBetween, roundedHours } from "./time";
import type { Block, Day, EditOp, Gap, TimesheetRow } from "./types";

/** Blocks that go on the timesheet: confirmed and billable. */
export function countedBlocks(day: Day): Block[] {
  return day.blocks.filter((b) => b.confirmed && b.billable);
}

/** Minutes a block counts for: the length you set, or its times. */
export function blockMinutes(b: Block): number {
  return b.minutes ?? minutesBetween(b.start, b.end);
}

/** A block's hours: exactly what you set, or its times rounded to `round_to`. */
export function blockHours(b: Block, config: Config): number {
  if (b.minutes !== undefined) return b.minutes / 60;
  return roundedHours(minutesBetween(b.start, b.end), durationMinutes(config.day.round_to));
}

/** Which timesheet row a block belongs to: the same project, task and description. */
export function rowKey(b: Pick<Block, "project" | "task" | "summary">): string {
  return JSON.stringify([b.project, b.task, b.summary]);
}

/**
 * One row per project, task and description: blocks of the same work are one timesheet entry.
 * Minutes are summed first and rounded once, in order of first appearance. A row with a length
 * you set counts exactly that, unrounded.
 */
export function timesheetRows(day: Day, config: Config): TimesheetRow[] {
  const step = durationMinutes(config.day.round_to);
  const groups = new Map<string, { row: TimesheetRow; minutes: number; set: boolean }>();
  for (const b of countedBlocks(day)) {
    const key = rowKey(b);
    const g = groups.get(key) ?? {
      row: { date: day.date, project: b.project, task: b.task, hours: 0, description: b.summary },
      minutes: 0,
      set: false,
    };
    g.minutes += blockMinutes(b);
    g.set ||= b.minutes !== undefined;
    groups.set(key, g);
  }
  return [...groups.values()].map((g) => ({
    ...g.row,
    hours: g.set ? g.minutes / 60 : roundedHours(g.minutes, step),
  }));
}

/**
 * Edits that make a timesheet row count `minutes`: the first block carries the length, the
 * rest count zero. Times don't move.
 */
export function setRowMinutesOps(day: Day, key: string, minutes: number): EditOp[] {
  const blocks = countedBlocks(day)
    .filter((b) => rowKey(b) === key)
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  return blocks.map((b, i) => ({
    op: "update" as const,
    id: b.id,
    minutes: i === 0 ? Math.max(0, Math.round(minutes)) : 0,
  }));
}

/** Edits that take a timesheet row off the day: its blocks are deleted (undo brings them back). */
export function removeRowOps(day: Day, key: string): EditOp[] {
  return countedBlocks(day)
    .filter((b) => rowKey(b) === key)
    .map((b) => ({ op: "delete" as const, id: b.id }));
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

/** One review-screen row: a block of work, or an unaccounted gap. */
export type Row = { kind: "block"; block: Block } | { kind: "gap"; gap: Gap };

/** Blocks and gaps of a day in chronological order. */
export function tableRows(day: Day): Row[] {
  return [
    ...day.blocks.map((block) => ({ kind: "block" as const, block })),
    ...day.gaps.map((gap) => ({ kind: "gap" as const, gap })),
  ].sort((a, b) => start(a) - start(b));
}

function start(r: Row): number {
  return (r.kind === "block" ? r.block.start : r.gap.start).getTime();
}
