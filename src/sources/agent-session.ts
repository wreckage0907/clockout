import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { Activity } from "../core/types";
import type { DateRange } from "./types";

// What coding-agent sources share: a session is a list of timed events, either the user typing
// or the agent working, and becomes prompt and agent-turn activities the same way for every agent.

export interface SessionEvent {
  at: Date;
  kind: "prompt" | "agent";
  cwd?: string | undefined;
  branch?: string | undefined;
}

export interface AgentSession {
  sessionId: string;
  title?: string | undefined;
  /** "owner/name" when the log names it; otherwise resolved from each event's `cwd`. */
  repo?: string | undefined;
  events: SessionEvent[];
  /** Lines that weren't valid JSON or didn't match the expected shape. */
  skipped: number;
}

/** Prompts become human activity; each run of agent events after a prompt becomes one agent turn. */
export async function* sessionActivities(
  source: string,
  session: AgentSession,
  range: DateRange,
  resolveRepo: (cwd: string) => Promise<string | undefined>,
): AsyncGenerator<Activity> {
  const inRange = (d: Date) => d >= range.from && d < range.to;
  const base = (e: SessionEvent) => ({
    source,
    title: session.title,
    cwd: e.cwd,
    branch: e.branch,
    sessionId: session.sessionId,
    refs: [`session:${session.sessionId}`],
  });
  const withRepo = async (a: Activity): Promise<Activity> => {
    const repo = session.repo ?? (a.cwd ? await resolveRepo(a.cwd) : undefined);
    return stripUndefined(repo ? { ...a, repo } : a);
  };

  let turn: { first: SessionEvent; last: SessionEvent } | null = null;
  const flush = async (): Promise<Activity | null> => {
    if (!turn || !inRange(turn.first.at)) return null;
    return withRepo({
      ...base(turn.first),
      kind: "agent_turn",
      actor: "agent",
      start: turn.first.at,
      end: turn.last.at,
    });
  };

  for (const e of session.events) {
    if (e.kind === "agent") {
      turn = turn ? { first: turn.first, last: e } : { first: e, last: e };
      continue;
    }
    const done = await flush();
    if (done) yield done;
    turn = null;
    if (inRange(e.at))
      yield await withRepo({ ...base(e), kind: "prompt", actor: "human", start: e.at });
  }
  const done = await flush();
  if (done) yield done;
}

/** Non-empty lines of a JSONL file, each parsed as JSON (`undefined` for a line that isn't). */
export async function* jsonLines(file: string): AsyncGenerator<unknown> {
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const raw of lines) {
    if (!raw.trim()) continue;
    try {
      yield JSON.parse(raw) as unknown;
    } catch {
      yield undefined;
    }
  }
}

/** A real file changed on or after `since`; older files can't hold events in a later range. */
export async function changedSince(file: string, since: Date): Promise<boolean> {
  const info = await stat(file).catch(() => null);
  return Boolean(info?.isFile() && info.mtime >= since);
}

/** An ISO timestamp as a Date, or null when it doesn't parse. */
export function parseTime(s: string | undefined): Date | null {
  if (!s) return null;
  const at = new Date(s);
  return Number.isNaN(at.getTime()) ? null : at;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
