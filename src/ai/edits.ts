import { z } from "zod";
import type { Config } from "../config/schema";
import { editOpSchema } from "../core/edit-schema";
import { prNumber } from "../core/summarize";
import { localDate, localTime, minutesBetween } from "../core/time";
import type { Day, EditOp } from "../core/types";
import type { LlmBackend } from "./types";

const SYSTEM = `You update a person's drafted timesheet from what they say (often dictated, so expect loose wording and misheard names).
Return edit operations on the day you're given, plus a one-sentence reply saying what you changed.

Rules:
- Use block ids (b1, b2…) and gap ids (g1, g2…) exactly as given. Never invent ids.
- Times are 24-hour local "HH:MM" on that day; "24:00" is midnight at the end of the day.
- A length without times ("standup ran to 45 minutes", "X was 2 hours"): update that block's minutes and leave its times alone. What counts on a timesheet is how long, not when.
- Lunch, breaks, personal time: fill_gap (or add) with billable false and project "Break".
- "I attended / was at <meeting>": update that meeting with confirmed true. "I skipped / missed <meeting>": delete it.
- Work without a time: put it in the earliest gap that fits, otherwise right after the last block of the day.
- Use project names from the day or the known projects list when one fits; otherwise use what the person said.
- Tasks: use one of the known tasks unless the person names another.
- People and PRs: match names like "Sam's PR" against the PR list.
- If you can't tell what they mean, return a single clarify op with a short question instead of guessing.
- Change only what they asked for.`;

export const correctionSchema = z.object({
  ops: z.array(editOpSchema),
  reply: z.string().describe("One short sentence describing the change, or empty"),
});
export type Correction = z.infer<typeof correctionSchema>;

/** The day as the AI sees it: times, ids, labels and PRs. No prompt text, no code. */
export function correctionContext(day: Day, config: Config, now = new Date()) {
  const tz = day.timezone;
  const t = (d: Date) => localTime(d, tz);
  // A block ending at the next midnight ends at "24:00" on this day, which edits accept.
  const tEnd = (d: Date) => (localDate(d, tz) > day.date ? "24:00" : t(d));
  const prs = new Map<string, { pr: string; title?: string; author?: string }>();
  for (const b of day.blocks) {
    for (const a of b.evidence) {
      const n = prNumber(a);
      if (!n || !a.repo) continue;
      const author = a.refs?.find((r) => r.startsWith("author:"))?.slice(7);
      prs.set(`${a.repo}#${n}`, {
        pr: `${a.repo}#${n}`,
        ...(a.title ? { title: a.title } : {}),
        ...(author ? { author } : {}),
      });
    }
  }
  return {
    date: day.date,
    timezone: tz,
    now: t(now),
    working_hours: config.day.working_hours,
    blocks: day.blocks.map((b) => ({
      id: b.id,
      start: t(b.start),
      end: tEnd(b.end),
      minutes: Math.round(b.minutes ?? minutesBetween(b.start, b.end)),
      kind: b.kind,
      project: b.project,
      task: b.task,
      summary: b.summary,
      confirmed: b.confirmed,
      billable: b.billable,
    })),
    gaps: day.gaps.map((g) => ({ id: g.id, start: t(g.start), end: tEnd(g.end) })),
    open_questions: day.questions.map((q) => q.text),
    known_projects: [
      ...new Set([...config.projects.map((p) => p.name), ...day.blocks.map((b) => b.project)]),
    ],
    known_tasks: [
      ...new Set([...Object.values(config.tasks), ...config.projects.flatMap((p) => p.task ?? [])]),
    ],
    prs: [...prs.values()],
  };
}

export async function parseCorrection(
  text: string,
  day: Day,
  config: Config,
  backend: LlmBackend,
): Promise<Correction> {
  const prompt = JSON.stringify({ day: correctionContext(day, config), said: text }, null, 2);
  return backend.complete({ system: SYSTEM, prompt, schema: correctionSchema });
}

export type { EditOp };
