import { useMemo, useState } from "react";
import { type Config, durationMinutes } from "../config/schema";
import { minutesBetween, roundedHours } from "../core/time";
import { countedBlocks } from "../core/timesheet";
import type { Block, Day, Question, TimesheetRow } from "../core/types";
import { projectColor } from "../tui/theme";
import {
  addTimeOps,
  answer,
  type Choice,
  choicesFor,
  evidenceLine,
  headline,
  meetingOf,
  short,
  why,
} from "./answers";
import type { Segment } from "./kit";

const SOURCE_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  github: "GitHub",
  calendar: "Calendar",
  "google-calendar": "Google Calendar",
};

/** One card in the day view: a timesheet row, or a meeting waiting for a yes or no. */
export interface Card {
  key: string;
  kind: "row" | "ask";
  title: string;
  project: string;
  task: string;
  /** Where the time came from: "Claude Code · 17 prompts in 1 session · opened PR #87". */
  from: string;
  /** Minutes on the sheet: what you set, or the rounded total of its blocks. */
  minutes: number;
  /** True when you set the minutes yourself. */
  edited: boolean;
  /** For ask cards: the question and its answers. */
  question?: string;
  reason?: string | null;
  choices?: Choice[];
  /** Earliest start, for ordering only. */
  first: number;
}

/** The sheet row a block belongs to. */
function rowKey(b: Pick<Block, "project" | "task" | "summary">): string {
  return JSON.stringify([b.project, b.task, b.summary]);
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

export function buildCards(day: Day, config: Config, overrides: Record<string, number>): Card[] {
  const step = durationMinutes(config.day.round_to);
  const groups = new Map<string, Block[]>();
  for (const b of countedBlocks(day)) {
    const k = rowKey(b);
    groups.set(k, [...(groups.get(k) ?? []), b]);
  }
  const rows: Card[] = [...groups].map(([key, blocks]) => {
    const b = blocks[0] as Block;
    const raw = blocks.reduce((s, x) => s + minutesBetween(x.start, x.end), 0);
    const set = overrides[key];
    return {
      key,
      kind: "row",
      title: b.summary,
      project: b.project,
      task: b.task,
      from: fromLine(blocks),
      minutes: set ?? roundedHours(raw, step) * 60,
      edited: set !== undefined,
      first: Math.min(...blocks.map((x) => x.start.getTime())),
    };
  });
  const asks: Card[] = day.questions.flatMap((q: Question) => {
    const b = meetingOf(day, q);
    if (!b) return []; // gap questions: see the note in answers.ts
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

interface State {
  day: Day;
  /** Hours you set by hand, by sheet row, in minutes. */
  overrides: Record<string, number>;
}

/**
 * The day as cards, with undo. Durations you type replace the computed ones and nothing else
 * moves: the total changes by exactly the difference. Answers and added time go through
 * core's edit validation, like a spoken correction would.
 */
export function useSheet(initial: Day, config: Config) {
  const [history, setHistory] = useState<State[]>([{ day: initial, overrides: {} }]);
  const state = history[history.length - 1] ?? { day: initial, overrides: {} };
  const { day, overrides } = state;
  const cards = useMemo(() => buildCards(day, config, overrides), [day, config, overrides]);
  const rows = cards.filter((c) => c.kind === "row");
  const minutes = rows.reduce((s, c) => s + c.minutes, 0);
  const untracked = day.gaps.reduce((s, g) => s + minutesBetween(g.start, g.end), 0);
  const push = (next: State) => setHistory((h) => [...h, next]);

  const by = new Map<string, number>();
  for (const c of rows) by.set(c.project, (by.get(c.project) ?? 0) + c.minutes);
  const segments: Segment[] = [...by]
    .sort((a, b) => b[1] - a[1])
    .map(([p, m]) => ({ label: short(p), color: projectColor(p), minutes: m }));

  return {
    day,
    cards,
    minutes,
    untracked,
    segments,
    asks: cards.filter((c) => c.kind === "ask").length,
    sheet: rows.map(
      (c): TimesheetRow => ({
        date: day.date,
        project: c.project,
        task: c.task,
        hours: c.minutes / 60,
        description: c.title,
      }),
    ),
    projects: [...new Set(day.blocks.filter((b) => b.billable).map((b) => b.project))],
    setMinutes(key: string, m: number) {
      push({ day, overrides: { ...overrides, [key]: Math.max(0, Math.round(m)) } });
    },
    choose(c: Choice): string | null {
      const r = answer(day, c, config);
      if (r.error) return r.error;
      push({ day: r.day, overrides });
      return null;
    },
    addTime(project: string, m: number, summary: string): string | null {
      const r = answer(day, { label: "", ops: addTimeOps(day, project, m, summary) }, config);
      if (r.error) return r.error;
      push({ day: r.day, overrides });
      return null;
    },
    undo(): boolean {
      if (history.length < 2) return false;
      setHistory((h) => h.slice(0, -1));
      return true;
    },
  };
}

export type Sheet = ReturnType<typeof useSheet>;
