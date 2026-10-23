import { z } from "zod";
import type { DescriptionStyle } from "../config/schema";
import { prNumber } from "../core/summarize";
import type { Block, Day } from "../core/types";
import type { LlmBackend } from "./types";

const FORMAT: Record<DescriptionStyle["format"], string> = {
  imperative: 'start with an imperative verb ("Fix", "Add", "Review", "Investigate")',
  past: 'start with a past-tense verb ("Fixed", "Added", "Reviewed", "Investigated")',
  continuous: 'start with an -ing verb ("Fixing", "Adding", "Reviewing", "Investigating")',
};
const LENGTH: Record<DescriptionStyle["length"], { rule: string; max: number }> = {
  short: { rule: "3 to 8 words", max: 120 },
  medium: { rule: "one sentence of 8 to 15 words", max: 200 },
  long: { rule: "one or two sentences, up to 30 words in all", max: 400 },
};
const DEFAULT_STYLE: DescriptionStyle = { format: "imperative", length: "short" };

/** The instructions for a style: the fixed rules, then the person's own words and examples. */
function systemFor(style: DescriptionStyle): string {
  const own = [
    style.instructions
      ? `\nTheir own instructions, followed unless they break the rules above:\n${style.instructions}`
      : "",
    style.examples?.length
      ? `\nDescriptions they wrote before. Match their style, not their content:\n${style.examples.map((e) => `- ${e}`).join("\n")}`
      : "",
  ].join("");
  return `You write timesheet descriptions. For each block of work you get the evidence: coding-session titles, pull requests, branches, reviewed PRs, issues opened or commented on.
Write one description per block id:
- ${LENGTH[style.length].rule}; ${FORMAT[style.format]}.
- Keep PR numbers as "(PR #n)" when a PR was opened or reviewed in the block.
- Only use facts in the evidence. No guesses, no caveats, no mention of what you can't see.
- Plain text, no quotes, no trailing period.${own}`;
}

function outputFor(style: DescriptionStyle) {
  const max = LENGTH[style.length].max;
  return z.object({
    summaries: z.array(z.object({ id: z.string(), summary: z.string().min(1).max(max) })),
  });
}

/**
 * Evidence that identifies a block's content, and the style when it isn't the default; equal
 * signatures can reuse a cached summary, so changing the style writes them again.
 */
export function blockSignature(b: Block, style: DescriptionStyle = DEFAULT_STYLE): string {
  const evidence = evidenceOf(b);
  const custom =
    style.format !== DEFAULT_STYLE.format ||
    style.length !== DEFAULT_STYLE.length ||
    !!style.instructions ||
    !!style.examples?.length;
  return JSON.stringify(custom ? { evidence, style } : evidence);
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
  style: DescriptionStyle = DEFAULT_STYLE,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const todo: Block[] = [];
  for (const b of day.blocks) {
    if (b.kind === "meeting" || b.evidence.length === 0) continue;
    const hit = cache[blockSignature(b, style)];
    if (hit) result.set(b.id, hit);
    else todo.push(b);
  }
  if (todo.length === 0) return result;

  const prompt = JSON.stringify(
    todo.map((b) => ({ id: b.id, ...evidenceOf(b) })),
    null,
    2,
  );
  const { summaries } = await backend.complete({
    system: systemFor(style),
    prompt,
    schema: outputFor(style),
  });
  const wanted = new Map(todo.map((b) => [b.id, b]));
  for (const { id, summary } of summaries) {
    const b = wanted.get(id);
    if (!b) continue;
    const clean = summary.trim().replace(/\.$/, "");
    result.set(id, clean);
    cache[blockSignature(b, style)] = clean;
  }
  return result;
}
