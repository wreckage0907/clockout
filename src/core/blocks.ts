import { type Config, durationMinutes } from "../config/schema";
import { resolveProject, ruleTask } from "./projects";
import { heuristicSummary } from "./summarize";
import { atLocalTime, dayRange, localTime, MINUTE } from "./time";
import type { Activity, Block, Day, Gap, Question } from "./types";

/** Reading the agent's reply, or the time after a review comment, before the next action. */
const TAIL = 5 * MINUTE;
/** Slivers shorter than this are folded into the neighbouring block. */
const SLIVER = 5 * MINUTE;
/** Gaps at least this long get a question. */
export const ASK_GAP_MINUTES = 30;
const ASK_GAP = ASK_GAP_MINUTES * MINUTE;
/** This many of your actions during an accepted meeting suggest you skipped it. */
const BUSY_IN_MEETING = 2;

interface Span {
  key: string;
  project: string;
  start: number;
  end: number;
  events: Activity[];
}

interface Piece {
  span: Span;
  start: number;
  end: number;
}

/** Turns one local day's activities into blocks, gaps and questions. Pure. */
export function buildDay(date: string, activities: readonly Activity[], config: Config): Day {
  const tz = config.me.timezone;
  const range = dayRange(date, tz);
  const [from, to] = [range.from.getTime(), range.to.getTime()];
  const idle = durationMinutes(config.day.idle_cutoff) * MINUTE;
  const notes: string[] = [];
  const questions: Omit<Question, "id">[] = [];

  const acts = activities
    .filter((a) => {
      const s = a.start.getTime();
      const e = a.end?.getTime() ?? s;
      return a.kind === "meeting" ? s < to && e > from : s >= from && s < to;
    })
    .map((a) => ({ ...a, project: resolveProject(a, config.projects) }));

  // Meetings
  const meetings = dedupeMeetings(acts.filter((a) => a.kind === "meeting" && a.end));
  const declined = meetings.filter((m) => m.attendance === "declined");
  if (declined.length) {
    notes.push(
      `Left out ${declined.length} declined meeting${declined.length === 1 ? "" : "s"}: ${declined
        .map((m) => m.title)
        .join(", ")}`,
    );
  }
  const attended = meetings.filter((m) => m.attendance === "accepted");
  const unsure = meetings.filter((m) => m.attendance !== "accepted" && m.attendance !== "declined");

  // Work: your actions → spans per project/branch → non-overlapping pieces
  const human = acts
    .filter((a) => a.actor === "human" && a.kind !== "meeting")
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const turns = acts.filter((a) => a.kind === "agent_turn");
  const spans = buildSpans(human, turns, idle);
  let pieces = foldSlivers(resolveOverlaps(spans));

  // Accepted meetings win over work; note when you were busy during one.
  for (const m of attended) {
    const [ms, me] = [m.start.getTime(), m.end?.getTime() ?? m.start.getTime()];
    const busy = human.filter((h) => h.start.getTime() >= ms && h.start.getTime() < me);
    if (busy.length >= BUSY_IN_MEETING) {
      questions.push({
        kind: "attendance",
        text: `You were active in ${busy[0]?.project} during "${m.title}" (${span(m, tz)}). Did you attend, or skip it?`,
        blockId: meetingKey(m),
      });
    }
    pieces = pieces.flatMap((p) => subtract(p, ms, me));
  }

  for (const m of unsure) {
    const overlapping = pieces.find(
      (p) => p.start < (m.end?.getTime() ?? 0) && p.end > m.start.getTime(),
    );
    const why = m.attendance === "tentative" ? "You replied maybe." : "You didn't reply.";
    questions.push({
      kind: "attendance",
      text: `Did you attend "${m.title}" (${span(m, tz)})? ${why}${
        overlapping ? ` You were working on ${overlapping.span.project} then.` : ""
      }`,
      blockId: meetingKey(m),
    });
  }

  // Blocks
  const blocks: Block[] = [];
  for (const p of pieces) {
    const evidence = [
      ...p.span.events.filter((e) => e.start.getTime() >= p.start && e.start.getTime() < p.end),
      ...turns.filter(
        (t) =>
          t.project === p.span.project && t.start.getTime() >= p.start && t.start.getTime() < p.end,
      ),
    ];
    if (evidence.length === 0) evidence.push(...p.span.events.slice(0, 1));
    const reviewOnly = evidence.every((e) => e.kind === "review" || e.kind === "review_comment");
    const kind = reviewOnly ? "review" : "work";
    blocks.push(
      finish(
        {
          kind,
          start: new Date(Math.max(p.start, from)),
          end: new Date(Math.min(p.end, to)),
          project: p.span.project,
          task:
            kind === "review"
              ? config.tasks.review
              : (ruleTask(evidence[0] as Activity, config.projects) ?? config.tasks.work),
          billable: true,
          confirmed: true,
          evidence,
        },
        p.span.key,
      ),
    );
  }
  for (const m of [...attended, ...unsure]) {
    blocks.push(
      finish(
        {
          kind: "meeting",
          start: new Date(Math.max(m.start.getTime(), from)),
          end: new Date(Math.min(m.end?.getTime() ?? to, to)),
          project: m.project ?? resolveProject(m, config.projects),
          task: ruleTask(m, config.projects) ?? config.tasks.meeting,
          billable: true,
          confirmed: m.attendance === "accepted",
          evidence: [m],
        },
        meetingKey(m),
      ),
    );
  }
  blocks.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());

  // Stable ids, and questions pointing at them
  const idByKey = new Map<string, string>();
  const keyed = blocks as (Block & { key?: string })[];
  keyed.forEach((b, i) => {
    b.id = `b${i + 1}`;
    if (b.key) idByKey.set(b.key, b.id);
    delete b.key;
  });

  // Gaps inside working hours
  const gaps = computeGaps(date, blocks, config);
  for (const g of gaps) {
    if (g.end.getTime() - g.start.getTime() < ASK_GAP) continue;
    const agent = agentDuring(turns, g.start.getTime(), g.end.getTime());
    questions.push({
      kind: "gap",
      text: agent
        ? `Nothing from you ${localTime(g.start, tz)}–${localTime(g.end, tz)}, but an agent was working in ${agent.project} for ${Math.round(agent.minutes)} min. Were you on it, or away?`
        : gapQuestionText(g, tz),
      gapId: g.id,
    });
  }

  return {
    date,
    timezone: tz,
    blocks,
    gaps,
    questions: questions.map((q, i) => {
      const out: Question = { ...q, id: `q${i + 1}` };
      if (q.blockId) {
        const id = idByKey.get(q.blockId);
        if (id) out.blockId = id;
        else delete out.blockId;
      }
      return out;
    }),
    notes,
  };
}

/** Each action claims time until the agent's reply is read (capped at the idle cutoff). */
function buildSpans(human: Activity[], turns: Activity[], idle: number): Span[] {
  const byKey = new Map<string, Span[]>();
  for (const h of human) {
    const t = h.start.getTime();
    let end = t + TAIL;
    if (h.kind === "prompt" && h.sessionId) {
      const reply = turns.find((x) => x.sessionId === h.sessionId && x.start.getTime() >= t);
      if (reply?.end) end = Math.max(end, reply.end.getTime() + TAIL);
    }
    end = Math.min(end, t + idle);
    const project = h.project ?? "Unsorted";
    const key = `${project}|${h.branch ?? h.refs?.find((r) => r.startsWith("pr:")) ?? ""}`;
    const list = byKey.get(key) ?? [];
    const last = list.at(-1);
    if (last && t - last.end <= idle) {
      last.end = Math.max(last.end, end);
      last.events.push(h);
    } else {
      list.push({ key: `${key}@${t}`, project, start: t, end, events: [h] });
    }
    byKey.set(key, list);
  }
  return [...byKey.values()].flat();
}

/** Where spans overlap, time goes to whichever you touched most recently. */
function resolveOverlaps(spans: Span[]): Piece[] {
  const points = [
    ...new Set(spans.flatMap((s) => [s.start, s.end, ...s.events.map((e) => e.start.getTime())])),
  ].sort((a, b) => a - b);
  const pieces: Piece[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const [p, q] = [points[i] as number, points[i + 1] as number];
    const covering = spans.filter((s) => s.start <= p && s.end >= q);
    if (covering.length === 0) continue;
    let winner = covering[0] as Span;
    let latest = -Infinity;
    for (const s of covering) {
      for (const e of s.events) {
        const t = e.start.getTime();
        if (t <= p && t > latest) [winner, latest] = [s, t];
      }
    }
    const prev = pieces.at(-1);
    if (prev && prev.span === winner && prev.end === p) prev.end = q;
    else pieces.push({ span: winner, start: p, end: q });
  }
  return pieces;
}

function foldSlivers(pieces: Piece[]): Piece[] {
  const out: Piece[] = [];
  for (const p of pieces) {
    const prev = out.at(-1);
    if (prev && p.end - p.start < SLIVER && prev.end === p.start) prev.end = p.end;
    else if (prev && prev.end - prev.start < SLIVER && prev.end === p.start) {
      out[out.length - 1] = { ...p, start: prev.start };
    } else out.push({ ...p });
  }
  return out;
}

function subtract(p: Piece, ms: number, me: number): Piece[] {
  if (me <= p.start || ms >= p.end) return [p];
  const out: Piece[] = [];
  if (ms - p.start >= SLIVER) out.push({ ...p, end: ms });
  if (p.end - me >= SLIVER) out.push({ ...p, start: me });
  return out;
}

/** Unaccounted stretches of at least `round_to` inside working hours, numbered g1, g2, … */
export function computeGaps(date: string, blocks: readonly Block[], config: Config): Gap[] {
  const tz = config.me.timezone;
  const step = durationMinutes(config.day.round_to) * MINUTE;
  const [whFrom, whTo] = config.day.working_hours.split("-") as [string, string];
  const end = atLocalTime(date, whTo, tz).getTime();
  let cursor = atLocalTime(date, whFrom, tz).getTime();
  const gaps: Gap[] = [];
  const sorted = [...blocks].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const b of sorted) {
    const [bs, be] = [b.start.getTime(), b.end.getTime()];
    if (Math.min(bs, end) - cursor >= step) {
      gaps.push({
        id: `g${gaps.length + 1}`,
        start: new Date(cursor),
        end: new Date(Math.min(bs, end)),
      });
    }
    cursor = Math.max(cursor, be);
  }
  if (end - cursor >= step) {
    gaps.push({ id: `g${gaps.length + 1}`, start: new Date(cursor), end: new Date(end) });
  }
  return gaps;
}

export function gapQuestionText(g: Gap, tz: string): string {
  return `Nothing recorded ${localTime(g.start, tz)}–${localTime(g.end, tz)}. Lunch, a break, or work?`;
}

/** The project an agent spent most time in during [from, to), if it ran for at least a third of it. */
function agentDuring(
  turns: Activity[],
  from: number,
  to: number,
): { project: string; minutes: number } | null {
  const byProject = new Map<string, number>();
  for (const t of turns) {
    const overlap = Math.min(t.end?.getTime() ?? 0, to) - Math.max(t.start.getTime(), from);
    if (overlap > 0 && t.project)
      byProject.set(t.project, (byProject.get(t.project) ?? 0) + overlap);
  }
  const [project, ms] = [...byProject].sort((a, b) => b[1] - a[1])[0] ?? [];
  return project && ms && ms >= (to - from) / 3 ? { project, minutes: ms / MINUTE } : null;
}

/** The same event can arrive from two calendars; keep one per event and start time. */
function dedupeMeetings(meetings: Activity[]): Activity[] {
  const seen = new Map<string, Activity>();
  for (const m of meetings) seen.set(meetingKey(m), seen.get(meetingKey(m)) ?? m);
  return [...seen.values()];
}

function meetingKey(m: Activity): string {
  return `meeting|${m.refs?.[0] ?? m.title}|${m.start.getTime()}`;
}

function span(a: Activity, tz: string): string {
  return `${localTime(a.start, tz)}–${a.end ? localTime(a.end, tz) : "?"}`;
}

function finish(b: Omit<Block, "id" | "summary">, key: string): Block & { key: string } {
  return { ...b, id: "", summary: heuristicSummary(b), key };
}
