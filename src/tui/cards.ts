import { type Config, durationMinutes } from "../config/schema";
import { mappingFor } from "../core/push";
import { minutesBetween, roundedHours } from "../core/time";
import { blockMinutes, countedBlocks, rowKey } from "../core/timesheet";
import type { Block, Day, Question } from "../core/types";
import {
  type Choice,
  choicesFor,
  evidenceLine,
  headline,
  meetingOf,
  short,
  why,
} from "./questions";
import { projectColor } from "./theme";

const SOURCE_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  pi: "Pi",
  codex: "Codex",
  github: "GitHub",
  calendar: "Calendar",
  "google-calendar": "Google Calendar",
};

/** One card in the day view: a timesheet row, or a meeting waiting for a yes or no. */
export interface Card {
  /** The timesheet row's key (see `rowKey`), or "ask:<block id>". */
  key: string;
  kind: "row" | "ask";
  title: string;
  project: string;
  task: string;
  /** Where the time came from: "Claude Code · 17 prompts in 1 session · opened PR #87". */
  from: string;
  /** Minutes on the sheet: what you set, or the rounded total of its blocks. */
  minutes: number;
  /** True when you set the length yourself. */
  edited: boolean;
  /**
   * Where the row goes in the ERP: a task picked for this card (`own`), its project's task, or
   * null when neither is picked yet. Undefined when no ERP is set up.
   */
  sendTo?: { label: string; own: boolean } | null;
  /** For ask cards: the question and its answers. */
  question?: string;
  reason?: string | null;
  choices?: Choice[];
  /** Earliest start, for ordering only. */
  first: number;
}

/** A project's share of the day, for the hours bar. */
export interface Segment {
  label: string;
  color: string;
  minutes: number;
}

function fromLine(blocks: Block[]): string {
  const evidence = blocks.flatMap((b) => b.evidence);
  const sources = [...new Set(evidence.map((a) => SOURCE_NAMES[a.source] ?? a.source))];
  const first = blocks[0];
  const detail = first ? evidenceLine({ ...first, evidence }) : "";
  return [sources.join(" + ") || "Added by you", detail === "added by you" ? "" : detail]
    .filter(Boolean)
    .join(" · ");
}

/**
 * The day as cards: one per timesheet row (same grouping and rounding as the export), plus one
 * per meeting waiting for an answer, in the order things started. Clock times aren't shown;
 * only how long.
 */
export function buildCards(day: Day, config: Config): Card[] {
  const step = durationMinutes(config.day.round_to);
  const groups = new Map<string, Block[]>();
  for (const b of countedBlocks(day)) groups.set(rowKey(b), [...(groups.get(rowKey(b)) ?? []), b]);
  const rows: Card[] = [...groups].map(([key, blocks]) => {
    const b = blocks[0] as Block;
    const minutes = blocks.reduce((s, x) => s + blockMinutes(x), 0);
    const edited = blocks.some((x) => x.minutes !== undefined);
    const own = blocks.find((x) => x.sendTo)?.sendTo;
    const mapped = config.timesheet ? mappingFor(b, config.timesheet.map) : undefined;
    return {
      key,
      kind: "row",
      title: b.summary,
      project: b.project,
      task: b.task,
      from: fromLine(blocks),
      minutes: edited ? minutes : roundedHours(minutes, step) * 60,
      edited,
      ...(config.timesheet
        ? {
            sendTo: own
              ? { label: own.label, own: true }
              : mapped
                ? { label: mapped.label ?? mapped.erp_task, own: false }
                : null,
          }
        : {}),
      first: Math.min(...blocks.map((x) => x.start.getTime())),
    };
  });
  const asks: Card[] = day.questions.flatMap((q: Question) => {
    const b = meetingOf(day, q);
    if (!b) return []; // gap questions: see the note in questions.ts
    return [
      {
        key: `ask:${b.id}`,
        kind: "ask" as const,
        title: b.summary,
        project: b.project,
        task: b.task,
        from: fromLine([b]),
        minutes: minutesBetween(b.start, b.end),
        edited: false,
        question: headline(b, q),
        reason: why(q),
        choices: choicesFor(b, q),
        first: b.start.getTime(),
      },
    ];
  });
  return [...rows, ...asks].sort((a, b) => a.first - b.first);
}

/** Minutes logged per project, biggest first. */
export function segments(cards: Card[]): Segment[] {
  const by = new Map<string, number>();
  for (const c of cards)
    if (c.kind === "row") by.set(c.project, (by.get(c.project) ?? 0) + c.minutes);
  return [...by]
    .sort((a, b) => b[1] - a[1])
    .map(([p, m]) => ({ label: short(p), color: projectColor(p), minutes: m }));
}
