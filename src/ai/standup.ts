import { z } from "zod";
import type { StandupStyle } from "../config/schema";
import { hasSecret, redactSecrets } from "../core/secrets";
import type { StandupFacts, StandupSections } from "../core/standup";
import { cleanText } from "../core/text";
import type { LlmBackend } from "./types";

const LENGTH: Record<StandupStyle["length"], { rule: string; items: number; max: number }> = {
  short: { rule: "at most 3 items per section, each a few words", items: 3, max: 120 },
  medium: { rule: "at most 5 items per section, each one short sentence", items: 5, max: 200 },
  long: { rule: "at most 8 items per section, each one or two sentences", items: 8, max: 300 },
};

function systemFor(style: StandupStyle): string {
  const form =
    style.format === "prose"
      ? "Each section is one item: a sentence or two in the first person, without the section's name."
      : `Each section is a list of items: ${LENGTH[style.length].rule}. No bullet characters.`;
  const own = [
    style.instructions
      ? `\nTheir own prompt for how the standup should read, followed unless it breaks the rules above:\n${style.instructions}`
      : "",
    style.examples?.length
      ? `\nStandups they wrote before. Match their style, not their content:\n${style.examples.map((e) => `---\n${e}`).join("\n")}\n---`
      : "",
  ].join("");
  return `You write a developer's daily standup from facts about their work. Return two sections:
- yesterday: what they did on the previous working day, from its timesheet rows (yesterday.items). Group rows of the same work; lead with what moved forward.
- today: what's next, from their open pull requests (prs), branches with no pull request yet (branches), reviews asked of them (reviews) and today's meetings (meetings).
Rules:
- ${form}
- Only use facts given. No guesses, no caveats, no blockers (they add those themselves), no hours unless their prompt asks.
- Keep PR numbers as "PR #n". Leave out breaks and the standup meeting itself.
- Plain text, no Markdown, no trailing period on list items.${own}`;
}

function outputFor(style: StandupStyle) {
  const { items, max } = LENGTH[style.length];
  const section = z
    .array(
      z
        .string()
        .min(1)
        .max(max * 2),
    )
    .max(style.format === "prose" ? 1 : items);
  return z.object({ yesterday: section, today: section });
}

/**
 * The standup's sections in one AI call, from titles and summaries only. An item that looks like
 * it holds a secret is dropped.
 */
export async function writeStandup(
  facts: StandupFacts,
  backend: LlmBackend,
  style: StandupStyle,
): Promise<StandupSections> {
  const { blockers: _, ...shown } = facts;
  const prompt = redactSecrets(JSON.stringify(shown, null, 2));
  const out = await backend.complete({
    system: systemFor(style),
    prompt,
    schema: outputFor(style),
  });
  const clean = (items: string[]) =>
    items.map((i) => cleanText(i).replace(/^[-•*]\s*/, "")).filter((i) => i && !hasSecret(i));
  return { yesterday: clean(out.yesterday), today: clean(out.today) };
}
