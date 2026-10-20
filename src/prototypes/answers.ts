import type { Config } from "../config/schema";
import { applyEdits, BREAK_PROJECT } from "../core/edits";
import { atLocalTime, localTime, MINUTE, minutesBetween } from "../core/time";
import type { Block, Day, EditOp, Gap, Question } from "../core/types";

/** A one-key answer to a question, and the edits it stands for. */
export interface Choice {
  label: string;
  ops: EditOp[];
}

/** What a question is about, for display: the block or gap, its times and length. */
interface Subject {
  start: Date;
  end: Date;
  minutes: number;
  block?: Block;
  gap?: Gap;
}

function subjectOf(day: Day, q: Question): Subject | null {
  const block = q.blockId ? day.blocks.find((b) => b.id === q.blockId) : undefined;
  const gap = q.gapId ? day.gaps.find((g) => g.id === q.gapId) : undefined;
  const at = block ?? gap;
  if (!at) return null;
  return { start: at.start, end: at.end, minutes: minutesBetween(at.start, at.end), block, gap };
}

/** The question in plain words, without the times (the screen shows those). */
export function headline(day: Day, q: Question): string {
  const s = subjectOf(day, q);
  if (s?.gap) return "Nothing recorded here. What were you doing?";
  const title = s?.block?.summary ?? "this meeting";
  if (q.kind === "overlap") return `“${title}” overlaps another meeting. Were you in it?`;
  if (q.text.includes("own calendar"))
    return `“${title}” is a block on your own calendar. Was it work?`;
  return `Did you attend “${title}”?`;
}

/** Extra context under the headline, from the original question. */
export function why(q: Question): string | null {
  if (q.text.includes("replied maybe")) return "You replied maybe.";
  if (q.text.includes("didn't reply")) return "You didn't reply to the invite.";
  const working = /You were (?:working on|active in) ([^\s.]+)/.exec(q.text)?.[1];
  if (working) return `You were also working on ${working} then.`;
  const agent = /an agent was working in (\S+) for (\d+) min/.exec(q.text);
  if (agent) return `An agent was working in ${agent[1]} for ${agent[2]} min.`;
  return null;
}

/** The block just before a gap, so "kept working" can name the project. */
function before(day: Day, gap: Gap): Block | undefined {
  return day.blocks
    .filter((b) => b.end.getTime() <= gap.start.getTime() && b.kind !== "meeting")
    .sort((a, b) => b.end.getTime() - a.end.getTime())[0];
}

export function choicesFor(day: Day, q: Question): Choice[] {
  const s = subjectOf(day, q);
  if (!s) return [];
  if (s.gap) {
    const g = s.gap;
    const prev = before(day, g);
    const out: Choice[] = [
      {
        label: "Lunch",
        ops: [
          {
            op: "fill_gap",
            gapId: g.id,
            project: BREAK_PROJECT,
            summary: "Lunch",
            billable: false,
          },
        ],
      },
      {
        label: "Break",
        ops: [
          {
            op: "fill_gap",
            gapId: g.id,
            project: BREAK_PROJECT,
            summary: "Break",
            billable: false,
          },
        ],
      },
    ];
    if (prev)
      out.push({
        label: `Kept on ${short(prev.project)}`,
        ops: [{ op: "fill_gap", gapId: g.id, project: prev.project, summary: prev.summary }],
      });
    return out;
  }
  const b = s.block;
  if (!b) return [];
  const ownBlock = q.text.includes("own calendar");
  return [
    {
      label: ownBlock ? "Yes, work" : "Attended",
      ops: [{ op: "update", id: b.id, confirmed: true }],
    },
    { label: ownBlock ? "Not work" : "Skipped", ops: [{ op: "delete", id: b.id }] },
  ];
}

/** Applies a choice; returns the new day, or the reasons it couldn't. */
export function answer(day: Day, choice: Choice, config: Config): { day: Day; error?: string } {
  const r = applyEdits(day, choice.ops, config);
  return r.errors.length ? { day, error: r.errors.join(" ") } : { day: r.day };
}

/** Long "owner/repo" names lose the owner ("dev-example/clockout" → "clockout"); short ones stay. */
export function short(project: string): string {
  if (project.length <= 14 || !project.includes("/")) return project;
  return project.split("/").pop() ?? project;
}

/** What a block is built from, in one short line: "18 prompts in 2 sessions · opened PR #87". */
export function evidenceLine(b: Block): string {
  const ev = b.evidence;
  const parts: string[] = [];
  const sessions = new Set(ev.filter((a) => a.sessionId).map((a) => a.sessionId)).size;
  const prompts = ev.filter((a) => a.kind === "prompt").length;
  if (prompts)
    parts.push(
      `${prompts} prompt${prompts === 1 ? "" : "s"}${sessions ? ` in ${sessions} session${sessions === 1 ? "" : "s"}` : ""}`,
    );
  const pr = (a: { refs?: string[] }) => a.refs?.find((r) => r.startsWith("pr:"))?.split("#")[1];
  for (const a of ev.filter((x) => x.kind === "pr")) parts.push(`opened PR #${pr(a) ?? "?"}`);
  const reviews = ev.filter((x) => x.kind === "review" || x.kind === "review_comment");
  if (reviews.length)
    parts.push(`${reviews.length} review comments on PR #${pr(reviews[0] ?? {}) ?? "?"}`);
  const meeting = ev.find((a) => a.kind === "meeting");
  if (meeting) {
    const rsvp: Record<string, string> = {
      accepted: "you accepted",
      tentative: "you said maybe",
      needs_action: "no reply",
      declined: "you declined",
      unknown: "on your calendar",
    };
    parts.push(rsvp[meeting.attendance ?? "unknown"] ?? "on your calendar");
  }
  if (b.project === BREAK_PROJECT) parts.push("not counted");
  return parts.length ? parts.join(" · ") : "added by you";
}

// ── Durations ───────────────────────────────────────────────────────────────

/**
 * A duration typed by hand: "1h", "1h 15m", "1h15", "45m", "1:15", "1.5", "1.5h", "90".
 * A bare number up to 12 is hours, anything bigger is minutes. Null when it isn't one.
 */
export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase();
  let m = /^(\d+(?:\.\d+)?)\s*h(?:ours?|rs?)?(?:\s*(\d+)\s*m?(?:in(?:ute)?s?)?)?$/.exec(t);
  if (m) return Math.round(Number(m[1]) * 60 + Number(m[2] ?? 0));
  m = /^(\d+)\s*m(?:in(?:ute)?s?)?$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(\d+):(\d{2})$/.exec(t);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d+(?:\.\d+)?)$/.exec(t);
  if (m) return Number(m[1]) <= 12 ? Math.round(Number(m[1]) * 60) : Number(m[1]);
  return null;
}

/**
 * Edits that add `minutes` of work for `project`: in the first untracked stretch long enough,
 * or right after the last thing you did.
 */
export function addTimeOps(day: Day, project: string, minutes: number, summary: string): EditOp[] {
  const tz = day.timezone;
  const gap = day.gaps.find((g) => minutesBetween(g.start, g.end) >= minutes);
  const last = [...day.blocks].sort((a, b) => b.end.getTime() - a.end.getTime())[0];
  const start = gap?.start ?? last?.end ?? atLocalTime(day.date, "09:00", tz);
  const end = new Date(start.getTime() + minutes * MINUTE);
  return [
    {
      op: "add",
      start: localTime(start, tz),
      end: localTime(end, tz),
      project,
      summary: summary || `Work on ${short(project)}`,
    },
  ];
}
