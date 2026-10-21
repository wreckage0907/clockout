import { ticketKeys } from "./projects";
import type { Activity, Block } from "./types";

/**
 * A short, verb-first line for a block, from the evidence alone (no AI):
 * meeting title, reviewed PR, session title, opened PR, issue discussed, or branch name.
 */
export function heuristicSummary(block: Pick<Block, "kind" | "evidence" | "project">): string {
  const ev = block.evidence;
  if (block.kind === "meeting") return ev[0]?.title ?? "Meeting";

  if (block.kind === "review") {
    const pr = ev.find((a) => a.kind === "review" || a.kind === "review_comment");
    const n = prNumber(pr);
    return pr?.title ? `Review ${pr.title}${n ? ` (PR #${n})` : ""}` : "Code review";
  }

  const opened = ev.find((a) => a.kind === "pr");
  const prSuffix = opened && prNumber(opened) ? ` (PR #${prNumber(opened)})` : "";
  const title =
    mostCommon(ev.filter((a) => a.kind === "prompt").map((a) => a.title)) ?? opened?.title;
  if (title) return `${title}${prSuffix}`;

  const talk = ev.find((a) => (a.kind === "issue" || a.kind === "comment") && a.title);
  if (talk?.title) {
    const ref = talk.refs?.[0]?.split("#");
    const n = ref?.[1] ? ` (${ref[0]?.startsWith("pr:") ? "PR " : ""}#${ref[1]})` : "";
    return `${talk.kind === "issue" ? "Open issue" : "Discuss"} ${talk.title}${n}`;
  }

  const branch = mostCommon(ev.map((a) => a.branch));
  if (branch && !["main", "master", "develop", "trunk"].includes(branch)) {
    const ticket = ticketKeys(branch)[0];
    return `${humanizeBranch(branch)}${prSuffix || (ticket ? ` (${ticket})` : "")}`;
  }
  return `Work on ${block.project}`;
}

export function prNumber(a: Activity | undefined): number | undefined {
  const ref = a?.refs?.find((r) => r.startsWith("pr:"));
  const n = ref ? Number(ref.split("#").pop()) : Number.NaN;
  return Number.isFinite(n) ? n : undefined;
}

/** "fix/auth-token_refresh" → "Fix auth token refresh" */
export function humanizeBranch(branch: string): string {
  const words = branch
    .replace(/^(feat|feature|fix|bugfix|hotfix|chore|refactor|docs|test)\//i, (m) =>
      m.toLowerCase().startsWith("feat") ? "add " : `${m.slice(0, -1)} `,
    )
    .replace(/[/_-]+/g, " ")
    .trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function mostCommon(values: (string | undefined)[]): string | undefined {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let max = 0;
  for (const [v, n] of counts) {
    if (n > max) [best, max] = [v, n];
  }
  return best;
}
