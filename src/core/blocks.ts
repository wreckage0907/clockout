import { type Config, durationMinutes } from "../config/schema";
import { ignoredBy, resolveProject, ruleTask } from "./projects";
import { heuristicSummary } from "./summarize";
import { atLocalTime, dayRange, formatDuration, localTime, MINUTE, minutesBetween } from "./time";
import type { Activity, Block, Day, Gap, Question } from "./types";

/** Reading the agent's reply, or the time after a review comment, before the next action. */
const TAIL = 5 * MINUTE;
/** Reading a pull request before your first comment or verdict on it. */
const REVIEW_READ = 15 * MINUTE;
/** Slivers shorter than this are folded into the neighbouring block. */
const SLIVER = 5 * MINUTE;
/** Gaps at least this long get a question. */
export const ASK_GAP_MINUTES = 30;
const ASK_GAP = ASK_GAP_MINUTES * MINUTE;
/** Gaps at least this long are never just lunch: the question asks what the work was. */
const LONG_GAP_MINUTES = 120;
/** Local times a gap has to touch for lunch to be a likely answer. */
const LUNCH = ["12:00", "15:00"] as const;
/** Events at least this long aren't taken as attended without asking. */
const LONG_EVENT = 10 * 60 * MINUTE;
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

  const ignored = new Set<string>();
  const acts = activities
    .filter((a) => {
      const s = a.start.getTime();
      const e = a.end?.getTime() ?? s;
      return a.kind === "meeting" ? s < to && e > from : s >= from && s < to;
    })
    .map((a) => ({ ...a, project: resolveProject(a, config.projects) }))
    .filter((a) => {
      const rule = ignoredBy(a.project, config.projects);
      if (rule) ignored.add(rule);
      return !rule;
    });
  if (ignored.size) notes.push(`Left out ${[...ignored].join(", ")}: your project rules ignore it`);

  // Meetings
  // An event of 10 hours or more (an offsite, a conference, a block over several days) isn't a
  // meeting you sat in around the clock: only its part in working hours counts, and it's asked about.
  const [whFrom, whTo] = config.day.working_hours.split("-") as [string, string];
  const [workFrom, workTo] = [atLocalTime(date, whFrom, tz), atLocalTime(date, whTo, tz)];
  const long = new Set<Activity>();
  const meetings = dedupeMeetings(acts.filter((a) => a.kind === "meeting" && a.end)).flatMap(
    (m) => {
      if ((m.end?.getTime() ?? 0) - m.start.getTime() < LONG_EVENT) return [m];
      const start = new Date(Math.max(m.start.getTime(), workFrom.getTime()));
      const end = new Date(Math.min(m.end?.getTime() ?? 0, workTo.getTime()));
      if (end <= start) return [];
      const clipped = { ...m, start, end };
      long.add(clipped);
      return [clipped];
    },
  );
  const declined = meetings.filter((m) => m.attendance === "declined");
  if (declined.length) {
    notes.push(
      `Left out ${declined.length} declined meeting${declined.length === 1 ? "" : "s"}: ${declined
        .map((m) => m.title)
        .join(", ")}`,
    );
  }
  // Of overlapping accepted meetings only the earliest counts; the others are asked about.
  const attended: Activity[] = [];
  const doubleBooked: { m: Activity; other: Activity }[] = [];
  for (const m of meetings
    .filter((x) => x.attendance === "accepted" && !long.has(x))
    .sort((a, b) => a.start.getTime() - b.start.getTime())) {
    const other = attended.find((o) => (o.end?.getTime() ?? 0) > m.start.getTime());
    if (other) doubleBooked.push({ m, other });
    else attended.push(m);
  }
  const unsure = [
    ...meetings.filter(
      (m) => (m.attendance !== "accepted" || long.has(m)) && m.attendance !== "declined",
    ),
    ...doubleBooked.map((d) => d.m),
  ];

  // Work: your actions → spans per project/branch → non-overlapping pieces
  const human = acts
    .filter((a) => a.actor === "human" && a.kind !== "meeting")
    .sort((a, b) => a.start.getTime() - b.start.getTime());
  const turns = acts.filter((a) => a.kind === "agent_turn");
  const spans = buildSpans(human, turns, idle, threads(human, turns));
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
    const working = overlapping ? ` You were working on ${overlapping.span.project} then.` : "";
    const clash = doubleBooked.find((d) => d.m === m);
    if (long.has(m)) {
      questions.push({
        kind: "attendance",
        text: `"${m.title}" is a long event; it's counted for your working hours (${span(m, tz)}). Were you at it all that time?${working}`,
        blockId: meetingKey(m),
      });
    } else if (clash) {
      questions.push({
        kind: "overlap",
        text: `"${m.title}" (${span(m, tz)}) overlaps "${clash.other.title}" (${span(clash.other, tz)}). Did you attend it too?`,
        blockId: meetingKey(m),
      });
    } else if (!m.attendees?.length) {
      questions.push({
        kind: "attendance",
        text: `Was "${m.title}" (${span(m, tz)}) work? It's a block on your own calendar.${working}`,
        blockId: meetingKey(m),
      });
    } else {
      const why = m.attendance === "tentative" ? "You replied maybe." : "You didn't reply.";
      questions.push({
        kind: "attendance",
        text: `Did you attend "${m.title}" (${span(m, tz)})? ${why}${working}`,
        blockId: meetingKey(m),
      });
    }
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
    // Someone else's PR: its comments and verdict, and trying it out on its branch.
    const reviewing = evidence.some(isReview) && !evidence.some((e) => e.kind === "pr");
    const kind = reviewing ? "review" : "work";
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
          confirmed: attended.includes(m),
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
        : gapQuestionText(g, tz, blocks),
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

function isReview(a: Activity): boolean {
  return a.kind === "review" || a.kind === "review_comment";
}

/** The PR a branch was fetched into by number: "pr-2305", "pr/2305", "pull/2305/head". */
function prOfBranch(branch: string): string | undefined {
  return /(?:^|\/)(?:pr|pull)[-_/]?(\d+)(?:\/head)?$/i.exec(branch)?.[1];
}

/** PR numbers a session title names: "Verify PR 2305 locally", "Review #2305". */
function prsInTitle(title: string): string[] {
  return [...title.matchAll(/(?:\bPR\s*#?|\bpull(?:\s+request)?\s*[#/]?|#)(\d+)\b/gi)].map(
    (m) => m[1] as string,
  );
}

/**
 * Which line of work each action belongs to. A PR you reviewed is one, including a session
 * where you tried it out: one that ran on its branch (under its own name, or fetched as
 * "pr-2305") or whose title names it. Otherwise the branch, or the PR or issue.
 */
function threads(human: Activity[], turns: Activity[]): Map<Activity, string> {
  const reviewed = human.filter(isReview).flatMap((a) => {
    const ref = a.refs?.find((r) => r.startsWith("pr:"));
    return ref ? [{ project: a.project, ref, branch: a.branch, n: ref.split("#").pop() }] : [];
  });
  const triedOut = (a: Activity) =>
    reviewed.find(
      (r) =>
        r.project === a.project &&
        ((a.branch && (r.branch === a.branch || r.n === prOfBranch(a.branch))) ||
          (a.title && r.n && prsInTitle(a.title).includes(r.n))),
    )?.ref;
  const bySession = new Map<string, string>();
  for (const a of [...human, ...turns]) {
    const ref = a.sessionId && !isReview(a) ? triedOut(a) : undefined;
    if (a.sessionId && ref) bySession.set(a.sessionId, ref);
  }
  const out = new Map<Activity, string>();
  for (const a of human) {
    const ref = a.refs?.find((r) => r.startsWith("pr:") || r.startsWith("issue:"));
    if (isReview(a) && ref) {
      out.set(a, ref);
      continue;
    }
    const pr = (a.sessionId ? bySession.get(a.sessionId) : undefined) ?? triedOut(a);
    out.set(a, pr ?? a.branch ?? ref ?? "");
  }
  return out;
}

/**
 * Each action claims time until the agent's reply is read (capped at the idle cutoff); a review
 * also claims the reading before it, where nothing else does. A comment on an issue joins
 * whatever you were doing in that project just then.
 */
function buildSpans(
  human: Activity[],
  turns: Activity[],
  idle: number,
  thread: Map<Activity, string>,
): Span[] {
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
    if ((h.kind === "issue" || h.kind === "comment") && !h.branch) {
      const open = [...byKey.values()]
        .flat()
        .filter((s) => s.project === project && t - s.end <= idle)
        .sort((a, b) => b.end - a.end)[0];
      if (open) {
        open.end = Math.max(open.end, end);
        open.events.push(h);
        continue;
      }
    }
    const key = `${project}|${thread.get(h) ?? ""}`;
    const list = byKey.get(key) ?? [];
    const last = list.at(-1);
    if (last && t - last.end <= idle) {
      last.end = Math.max(last.end, end);
      last.events.push(h);
    } else {
      const start = isReview(h) ? t - Math.min(REVIEW_READ, idle) : t;
      list.push({ key: `${key}@${t}`, project, start, end, events: [h] });
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

/**
 * A lone sliver joins the block next to it. A run of slivers is switching back and forth between
 * sessions running side by side: each gets its share of that stretch as one piece, in the order
 * they came up, so none takes the whole stretch.
 */
function foldSlivers(pieces: Piece[]): Piece[] {
  const short = (p: Piece) => p.end - p.start < SLIVER;
  const out: Piece[] = [];
  for (let i = 0; i < pieces.length; ) {
    const p = pieces[i] as Piece;
    let j = i + 1;
    if (short(p))
      while (
        j < pieces.length &&
        short(pieces[j] as Piece) &&
        pieces[j]?.start === pieces[j - 1]?.end
      )
        j++;
    if (j - i > 1) out.push(...shared(pieces.slice(i, j)));
    else out.push({ ...p });
    i = j;
  }
  const folded: Piece[] = [];
  for (const p of out) {
    const prev = folded.at(-1);
    const touching = prev && prev.end === p.start;
    if (touching && prev.span === p.span) prev.end = p.end;
    else if (touching && short(p) && !short(prev)) prev.end = p.end;
    else if (touching && short(prev)) folded[folded.length - 1] = { ...p, start: prev.start };
    else folded.push({ ...p });
  }
  return folded;
}

/** One piece per span over the run's time, each as long as its slivers added up. */
function shared(run: Piece[]): Piece[] {
  const total = new Map<Span, number>();
  for (const p of run) total.set(p.span, (total.get(p.span) ?? 0) + p.end - p.start);
  let at = (run[0] as Piece).start;
  return [...total].map(([span, ms]) => {
    const piece = { span, start: at, end: at + ms };
    at += ms;
    return piece;
  });
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

/**
 * What to ask about a gap. A long one asks what you were working on, naming the work around it;
 * a short one offers a break (lunch only around midday) or work.
 */
export function gapQuestionText(g: Gap, tz: string, blocks: readonly Block[] = []): string {
  const [from, to] = [localTime(g.start, tz), localTime(g.end, tz)];
  const minutes = minutesBetween(g.start, g.end);
  if (minutes >= LONG_GAP_MINUTES) {
    const work = blocks.filter((b) => b.kind !== "meeting" && b.billable);
    const before = work.filter((b) => b.end <= g.start).at(-1)?.project;
    const after = work.find((b) => b.start >= g.end)?.project;
    const around =
      before && before === after
        ? ` You were on ${before} before and after.`
        : before && after
          ? ` You were on ${before} before it and ${after} after.`
          : before
            ? ` You were on ${before} before it.`
            : after
              ? ` You were on ${after} after it.`
              : "";
    return `Nothing recorded ${from}–${to} (${formatDuration(minutes)}). What were you working on?${around}`;
  }
  const lunch = from < LUNCH[1] && to > LUNCH[0];
  return `Nothing recorded ${from}–${to}. ${lunch ? "Lunch, a break, or work?" : "A break, or work?"}`;
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
