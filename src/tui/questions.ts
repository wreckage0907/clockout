import { BREAK_PROJECT } from "../core/edits";
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
