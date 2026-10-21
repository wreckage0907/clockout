import { z } from "zod";
import { prNumber } from "../core/summarize";
import type { Block, Day } from "../core/types";
import type { LlmBackend } from "./types";

const SYSTEM = `You write timesheet descriptions. For each block of work you get the evidence: coding-session titles, pull requests, branches, reviewed PRs, issues opened or commented on.
Write one description per block id:
- 3 to 8 words, start with a past-tense or imperative verb ("Fix", "Add", "Review", "Investigate").
- Keep PR numbers as "(PR #n)" when a PR was opened or reviewed in the block.
- Only use facts in the evidence. No guesses, no caveats, no mention of what you can't see.
- Plain text, no quotes, no trailing period.`;

const output = z.object({
  summaries: z.array(z.object({ id: z.string(), summary: z.string().min(1).max(120) })),
});

/** Evidence that identifies a block's content; equal signatures can reuse a cached summary. */
export function blockSignature(b: Block): string {
  return JSON.stringify(evidenceOf(b));
}

function evidenceOf(b: Block) {
  const uniq = (xs: (string | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))];
  const discussed = uniq(
    b.evidence
      .filter((a) => a.kind === "issue" || a.kind === "comment")
      .map((a) => `${a.kind === "issue" ? "opened" : "commented on"} ${a.title ?? ""}`.trim()),
  );
  return {
    kind: b.kind,
    project: b.project,
    sessions: uniq(b.evidence.filter((a) => a.kind === "prompt").map((a) => a.title)),
    openedPrs: uniq(
      b.evidence
        .filter((a) => a.kind === "pr")
        .map((a) => `#${prNumber(a)} ${a.title ?? ""}`.trim()),
    ),
    reviewedPrs: uniq(
      b.evidence
        .filter((a) => a.kind === "review" || a.kind === "review_comment")
        .map((a) => `#${prNumber(a)} ${a.title ?? ""}`.trim()),
    ),
    branches: uniq(b.evidence.map((a) => a.branch)),
    // Only when there are some, so blocks without them keep their cached summaries.
    ...(discussed.length ? { discussed } : {}),
  };
}

/**
 * Better one-line summaries for work and review blocks, reusing `cache` (signature → summary).
 * Meetings keep their calendar titles. Returns the summaries for this day, by block id.
 */
export async function summarizeDay(
  day: Day,
  backend: LlmBackend,
  cache: Record<string, string>,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const todo: Block[] = [];
  for (const b of day.blocks) {
    if (b.kind === "meeting" || b.evidence.length === 0) continue;
    const hit = cache[blockSignature(b)];
    if (hit) result.set(b.id, hit);
    else todo.push(b);
  }
  if (todo.length === 0) return result;

  const prompt = JSON.stringify(
    todo.map((b) => ({ id: b.id, ...evidenceOf(b) })),
    null,
    2,
  );
  const { summaries } = await backend.complete({ system: SYSTEM, prompt, schema: output });
  const wanted = new Map(todo.map((b) => [b.id, b]));
  for (const { id, summary } of summaries) {
    const b = wanted.get(id);
    if (!b) continue;
    const clean = summary.trim().replace(/\.$/, "");
    result.set(id, clean);
    cache[blockSignature(b)] = clean;
  }
  return result;
}
