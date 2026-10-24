import type { Config } from "../config/schema";
import { ASK_GAP_MINUTES, computeGaps, gapQuestionText } from "./blocks";
import { BREAK_PROJECT } from "./projects";
import { cleanText } from "./text";
import { addDays, atLocalTime, formatDuration, localTime, MINUTE, minutesBetween } from "./time";
import { blockMinutes } from "./timesheet";
import type { Block, Day, EditOp, Question } from "./types";

const MIN_LEFTOVER = 5 * MINUTE;

/** Project used for lunch and breaks when no project is given. */
export { BREAK_PROJECT };

export interface EditResult {
  day: Day;
  /** Why the edits were rejected; when non-empty, `day` is unchanged. */
  errors: string[];
  /** Questions the AI asked back (`clarify` ops). */
  clarifications: string[];
}

/**
 * Applies edits all-or-nothing. The block you just edited wins overlaps with other confirmed
 * blocks (they're trimmed or split); unconfirmed meetings are left alone. Gaps and questions are
 * recalculated afterwards. Pure.
 */
/**
 * Edits that add `minutes` of work for `project` without asking for a clock time: in the first
 * untracked stretch long enough, otherwise right after the last thing you did.
 */
export function placeTimeOps(
  day: Day,
  project: string,
  minutes: number,
  summary: string,
): EditOp[] {
  const tz = day.timezone;
  const gap = day.gaps.find((g) => minutesBetween(g.start, g.end) >= minutes);
  const last = [...day.blocks].sort((a, b) => b.end.getTime() - a.end.getTime())[0];
  const start = gap?.start ?? last?.end ?? atLocalTime(day.date, "09:00", tz);
  const endsAt = new Date(start.getTime() + minutes * MINUTE);
  const midnight = atLocalTime(addDays(day.date, 1), "00:00", tz);
  return [
    {
      op: "add",
      start: localTime(start, tz),
      end: endsAt >= midnight ? "24:00" : localTime(endsAt, tz),
      project,
      summary: summary || `Work on ${project}`,
    },
  ];
}

export function applyEdits(day: Day, given: readonly EditOp[], config: Config): EditResult {
  const ops = given.map(cleanOp);
  const tz = day.timezone;
  const errors: string[] = [];
  const clarifications: string[] = [];
  const touched = new Set<string>();
  let blocks: Block[] = day.blocks.map((b) => ({ ...b, evidence: [...b.evidence] }));
  let nextId = Math.max(0, ...blocks.map((b) => Number(b.id.slice(1)) || 0)) + 1;
  const newId = () => `b${nextId++}`;

  const at = (hhmm: string) =>
    hhmm === "24:00"
      ? atLocalTime(addDays(day.date, 1), "00:00", tz)
      : atLocalTime(day.date, hhmm, tz);
  const find = (id: string) => {
    const b = blocks.find((x) => x.id === id);
    if (!b) errors.push(`There's no block ${id}.`);
    return b;
  };
  const taskFor = (kind: Block["kind"]) =>
    kind === "meeting"
      ? config.tasks.meeting
      : kind === "review"
        ? config.tasks.review
        : config.tasks.work;
  /** A project's own default task, e.g. one added by hand with a task. */
  const projectTask = (project: string) =>
    config.projects.find((p) => p.task && p.name.toLowerCase() === project.toLowerCase())?.task;
  const kindFor = (task: string | undefined): Block["kind"] =>
    task === config.tasks.meeting ? "meeting" : task === config.tasks.review ? "review" : "work";

  /** Trim or split confirmed blocks that overlap `winner`. */
  const claim = (winner: Block) => {
    if (!winner.confirmed) return;
    const [ws, we] = [winner.start.getTime(), winner.end.getTime()];
    const out: Block[] = [];
    for (const b of blocks) {
      const [bs, be] = [b.start.getTime(), b.end.getTime()];
      if (b === winner || !b.confirmed || be <= ws || bs >= we) {
        out.push(b);
        continue;
      }
      if (bs < ws) out.push({ ...b, end: winner.start });
      if (be > we) {
        const after: Block = { ...b, id: bs < ws ? newId() : b.id, start: winner.end };
        // A length you set counts once: it stays with the first piece.
        if (bs < ws) delete after.minutes;
        out.push(after);
      }
    }
    // Leftovers this short would bill a full rounding step for almost nothing.
    blocks = out.filter((b) => b.end.getTime() - b.start.getTime() >= MIN_LEFTOVER);
  };

  const validRange = (start: Date, end: Date) => {
    if (end <= start)
      errors.push(`${localTime(start, tz)}–${localTime(end, tz)} ends before it starts.`);
    return end > start;
  };

  for (const op of ops) {
    switch (op.op) {
      case "add": {
        const [start, end] = [at(op.start), at(op.end)];
        if (!validRange(start, end)) break;
        const kind = kindFor(op.task);
        const b: Block = {
          id: newId(),
          start,
          end,
          project: op.project,
          task: op.task ?? (kind === "work" ? projectTask(op.project) : undefined) ?? taskFor(kind),
          summary: op.summary,
          kind,
          billable: op.billable ?? true,
          confirmed: true,
          evidence: [],
        };
        blocks.push(b);
        touched.add(b.id);
        claim(b);
        break;
      }
      case "update": {
        const b = find(op.id);
        if (!b) break;
        const start = op.start ? at(op.start) : b.start;
        const end = op.end ? at(op.end) : b.end;
        if (!validRange(start, end)) break;
        Object.assign(b, {
          start,
          end,
          project: op.project ?? b.project,
          task: op.task ?? b.task,
          summary: op.summary ?? b.summary,
          billable: op.billable ?? b.billable,
          confirmed: op.confirmed ?? b.confirmed,
        });
        if (op.minutes !== undefined) b.minutes = op.minutes;
        touched.add(b.id);
        claim(b);
        break;
      }
      case "delete": {
        if (find(op.id)) {
          blocks = blocks.filter((b) => b.id !== op.id);
          touched.add(op.id);
        }
        break;
      }
      case "split": {
        const b = find(op.id);
        if (!b) break;
        const t = at(op.at);
        if (t <= b.start || t >= b.end) {
          errors.push(
            `${op.at} isn't inside ${b.id} (${localTime(b.start, tz)}–${localTime(b.end, tz)}).`,
          );
          break;
        }
        const second: Block = {
          ...b,
          id: newId(),
          start: t,
          evidence: b.evidence.filter((e) => e.start >= t),
        };
        b.evidence = b.evidence.filter((e) => e.start < t);
        b.end = t;
        // A length you set was for the whole block; each half goes back to its times.
        delete b.minutes;
        delete second.minutes;
        blocks.push(second);
        touched.add(b.id).add(second.id);
        break;
      }
      case "merge": {
        const ids = [...new Set(op.ids)];
        if (ids.length < 2) {
          errors.push("Merging needs at least two different blocks.");
          break;
        }
        const found = ids.map(find).filter((b): b is Block => !!b);
        if (found.length !== ids.length) break;
        found.sort((a, b) => a.start.getTime() - b.start.getTime());
        const [first, ...rest] = found as [Block, ...Block[]];
        // Lengths you set carry over: the merged block counts what its parts counted.
        if (found.some((b) => b.minutes !== undefined))
          first.minutes = found.reduce((sum, b) => sum + blockMinutes(b), 0);
        first.end = new Date(Math.max(...found.map((b) => b.end.getTime())));
        first.evidence = found.flatMap((b) => b.evidence);
        blocks = blocks.filter((b) => !rest.includes(b));
        touched.add(first.id);
        for (const b of rest) touched.add(b.id);
        claim(first);
        break;
      }
      case "fill_gap": {
        const gap = day.gaps.find((g) => g.id === op.gapId);
        if (!gap) {
          errors.push(`There's no gap ${op.gapId}.`);
          break;
        }
        const billable = op.billable ?? true;
        const project = op.project ?? (billable ? undefined : BREAK_PROJECT);
        if (!project) {
          errors.push(`Which project was ${localTime(gap.start, tz)}–${localTime(gap.end, tz)}?`);
          break;
        }
        const b: Block = {
          id: newId(),
          start: gap.start,
          end: gap.end,
          project,
          task: op.task ?? (billable ? config.tasks.work : BREAK_PROJECT),
          summary: op.summary,
          kind: kindFor(op.task),
          billable,
          confirmed: true,
          evidence: [],
        };
        blocks.push(b);
        touched.add(b.id);
        claim(b);
        break;
      }
      case "clarify":
        clarifications.push(op.question);
        break;
      case "send_to": {
        const b = find(op.id);
        if (!b) break;
        if (op.task === null) delete b.sendTo;
        else b.sendTo = { task: op.task, label: op.label ?? op.task };
        break;
      }
    }
  }

  if (errors.length) return { day, errors, clarifications };

  blocks.sort((a, b) => a.start.getTime() - b.start.getTime() || a.end.getTime() - b.end.getTime());
  const gaps = computeGaps(day.date, blocks, config);
  const ids = new Set(blocks.map((b) => b.id));

  // Keep questions about blocks you haven't touched; re-ask about gaps that are still there.
  const kept = day.questions.filter(
    (q) => q.kind !== "gap" && (!q.blockId || (ids.has(q.blockId) && !touched.has(q.blockId))),
  );
  const oldGapText = new Map(
    day.questions
      .filter((q) => q.kind === "gap" && q.gapId)
      .map((q) => {
        const g = day.gaps.find((x) => x.id === q.gapId);
        return [g ? `${g.start.getTime()}-${g.end.getTime()}` : "", q.text] as const;
      }),
  );
  const gapQuestions: Omit<Question, "id">[] = gaps
    .filter((g) => minutesBetween(g.start, g.end) >= ASK_GAP_MINUTES)
    .map((g) => ({
      kind: "gap",
      gapId: g.id,
      text:
        oldGapText.get(`${g.start.getTime()}-${g.end.getTime()}`) ?? gapQuestionText(g, tz, blocks),
    }));

  return {
    day: {
      ...day,
      blocks,
      gaps,
      questions: [...kept, ...gapQuestions].map((q, i) => ({ ...q, id: `q${i + 1}` })),
    },
    errors,
    clarifications,
  };
}

/** One line per change, for the "Proposed:" preview. */
export function describeEdits(day: Day, ops: readonly EditOp[]): string[] {
  const tz = day.timezone;
  const t = (d: Date) => localTime(d, tz);
  const name = (id: string) => {
    const b = day.blocks.find((x) => x.id === id);
    return b ? `${id} ${b.summary}` : id;
  };
  return ops.map((op) => {
    switch (op.op) {
      case "add":
        return `Add ${op.start}–${op.end} ${op.project}: ${op.summary}${op.billable === false ? " (not billed)" : ""}`;
      case "update": {
        const b = day.blocks.find((x) => x.id === op.id);
        const parts: string[] = [];
        if (op.start || op.end) {
          const from = b ? `${t(b.start)}–${t(b.end)}` : "";
          const to = `${op.start ?? (b ? t(b.start) : "?")}–${op.end ?? (b ? t(b.end) : "?")}`;
          parts.push(`${from} → ${to}`);
        }
        if (op.project) parts.push(`project → ${op.project}`);
        if (op.task) parts.push(`task → ${op.task}`);
        if (op.summary) parts.push(`“${op.summary}”`);
        if (op.billable === false) parts.push("not billed");
        if (op.billable === true) parts.push("billed");
        if (op.confirmed === true) parts.push("attended");
        if (op.minutes !== undefined) parts.push(`length → ${formatDuration(op.minutes)}`);
        return `${name(op.id)}: ${parts.join(", ") || "no change"}`;
      }
      case "delete":
        return `Remove ${name(op.id)}`;
      case "split":
        return `Split ${name(op.id)} at ${op.at}`;
      case "merge":
        return `Merge ${op.ids.join(" + ")}`;
      case "fill_gap": {
        const g = day.gaps.find((x) => x.id === op.gapId);
        const when = g
          ? `${t(g.start)}–${t(g.end)} (${formatDuration(minutesBetween(g.start, g.end))})`
          : op.gapId;
        return `Fill ${when} with ${op.summary}${op.billable === false ? " (not billed)" : ""}`;
      }
      case "clarify":
        return `Question: ${op.question}`;
      case "send_to":
        return op.task === null
          ? `${name(op.id)}: send to its project's ERP task`
          : `${name(op.id)}: send to ${op.label ?? op.task}`;
      default:
        return op satisfies never;
    }
  });
}

/** The op with its words as one line of plain text (they come from the AI or a typed sentence). */
function cleanOp(op: EditOp): EditOp {
  const out: Record<string, unknown> = { ...op };
  for (const k of ["project", "task", "summary", "question"])
    if (typeof out[k] === "string") out[k] = cleanText(out[k] as string);
  return out as unknown as EditOp;
}
