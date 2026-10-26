import { BREAK_PROJECT } from "../core/edits";
import { cleanText } from "../core/text";
import type { Block, Day, EditOp, Question } from "../core/types";

/** A one-key answer to a question, and the edits it stands for. */
export interface Choice {
  label: string;
  ops: EditOp[];
}

// Only questions about a meeting get an answer card. Gap questions are left to the "Add time"
// card: an untracked stretch only matters if you want hours there, and lunch never goes on the
// sheet, so there's nothing to ask.

/** The meeting a question is about, if it is about one. */
export function meetingOf(day: Day, q: Question): Block | undefined {
  return q.blockId ? day.blocks.find((b) => b.id === q.blockId) : undefined;
}

/** The question in plain words, without the times (the card shows those). */
export function headline(b: Block, q: Question): string {
  if (q.kind === "overlap") return `“${b.summary}” overlaps another meeting. Were you in it?`;
  if (q.text.includes("own calendar"))
    return `“${b.summary}” is a block on your own calendar. Was it work?`;
  return `Did you attend “${b.summary}”?`;
}

/** Extra context under the headline, from the original question. */
export function why(q: Question): string | null {
  if (q.text.includes("replied maybe")) return "You replied maybe.";
  if (q.text.includes("didn't reply")) return "You didn't reply to the invite.";
  const working = /You were (?:working on|active in) ([^\s.]+)/.exec(q.text)?.[1];
  return working ? `You were also working on ${working} then.` : null;
}

export function choicesFor(b: Block, q: Question): Choice[] {
  const ownBlock = q.text.includes("own calendar");
  return [
    {
      label: ownBlock ? "Yes, work" : "Attended",
      ops: [{ op: "update", id: b.id, confirmed: true }],
    },
    { label: ownBlock ? "Not work" : "Skipped", ops: [{ op: "delete", id: b.id }] },
  ];
}

/** Long "owner/repo" names lose the owner ("dev-example/clockout" → "clockout"); short ones stay. */
export function short(project: string): string {
  if (project.length <= 14 || !project.includes("/")) return project;
  return project.split("/").pop() ?? project;
}

/**
 * What a block is built from, in one short line: "18 prompts in 2 sessions · opened PR #87",
 * "reviewed PR #212 · 3 comments", "commented on issue #90".
 */
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
  for (const n of new Set(ev.filter(isReview).map((a) => pr(a) ?? "?"))) {
    const on = ev.filter((a) => isReview(a) && (pr(a) ?? "?") === n);
    const comments = plural(on.filter((a) => a.kind === "review_comment").length, "comment");
    if (on.some((a) => a.kind === "review"))
      parts.push(`reviewed PR #${n}${comments ? ` · ${comments}` : ""}`);
    else parts.push(`${comments} on PR #${n}`);
  }
  for (const a of ev.filter((x) => x.kind === "issue")) parts.push(`opened ${ref(a)}`);
  for (const r of new Set(ev.filter((x) => x.kind === "comment").map(ref))) {
    const n = ev.filter((a) => a.kind === "comment" && ref(a) === r).length;
    parts.push(n === 1 ? `commented on ${r}` : `${n} comments on ${r}`);
  }
  const meeting = ev.find((a) => a.kind === "meeting");
  if (meeting) {
    const rsvp: Record<string, string> = {
      accepted: "you accepted",
      tentative: "you said maybe",
      needs_action: "no reply",
      declined: "you declined",
      unknown: "on your calendar",
    };
    if (meeting.recorded) {
      // A recording settles attendance: say how long it ran instead of your RSVP.
      const minutes = meeting.end
        ? Math.round((meeting.end.getTime() - meeting.start.getTime()) / 60000)
        : 0;
      parts.push(minutes > 0 ? `recorded ${howLong(minutes)}` : "recorded");
    } else parts.push(rsvp[meeting.attendance ?? "unknown"] ?? "on your calendar");
    // A recorder's summary is private (ADR 0010): on screen, and nowhere else.
    if (meeting.notes) parts.push(`“${clip(meeting.notes, 100)}”`);
  }
  if (b.project === BREAK_PROJECT) parts.push("not counted");
  return parts.length ? parts.join(" · ") : "added by you";
}

function isReview(a: { kind: string }): boolean {
  return a.kind === "review" || a.kind === "review_comment";
}

/** "issue #90" or "PR #48", from an activity's first reference. */
function ref(a: { refs?: string[] }): string {
  const [kind, n] = a.refs?.[0]?.split("#") ?? [];
  return `${kind?.startsWith("pr:") ? "PR" : "issue"} #${n ?? "?"}`;
}

function plural(n: number, word: string): string {
  return n ? `${n} ${word}${n === 1 ? "" : "s"}` : "";
}

function clip(text: string, max: number): string {
  const one = cleanText(text);
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** "47m", "1h", "1h30m" */
function howLong(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}` || "0m";
}
