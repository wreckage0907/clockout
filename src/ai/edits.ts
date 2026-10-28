import { z } from "zod";
import { type Config, targetHost } from "../config/schema";
import { aiSettingOpSchema, type ClaudeProjectRef, type SettingOp } from "../config/setting-ops";
import { editOpSchema } from "../core/edit-schema";
import { applyEdits } from "../core/edits";
import { hasSecret, redactSecrets } from "../core/secrets";
import { prNumber } from "../core/summarize";
import { localDate, localTime, minutesBetween } from "../core/time";
import type { Day, EditOp } from "../core/types";
import type { LlmBackend } from "./types";

const SYSTEM = `You update a person's drafted timesheet, and Clockout's settings, from what they say (often dictated, so expect loose wording and misheard names).
Return edit operations on the day you're given in "ops", settings changes in "settings", plus a one-sentence reply saying what you changed.

Rules:
- Use block ids (b1, b2…) and gap ids (g1, g2…) exactly as given. Never invent ids.
- Times are 24-hour local "HH:MM" on that day; "24:00" is midnight at the end of the day.
- A length without times ("standup ran to 45 minutes", "X was 2 hours"): update that block's minutes and leave its times alone. What counts on a timesheet is how long, not when.
- Lunch, breaks, personal time: fill_gap (or add) with billable false and project "Break".
- "I attended / was at <meeting>": update that meeting with confirmed true. "I skipped / missed <meeting>": delete it.
- A stretch that spans several gaps ("everything between 12:45 and 16:00 was next-pms"): fill_gap each gap inside it with the same project and summary.
- Work without a time: put it in the earliest gap that fits, otherwise right after the last block of the day.
- Use project names from the day or the known projects list when one fits; otherwise use what the person said.
- Tasks: use one of the known tasks unless the person names another.
- People and PRs: match names like "Sam's PR" against the PR list.
- If you can't tell what they mean, return a single clarify op with a short question instead of guessing.
- Change only what they asked for.

Settings (what Clockout reads and how it counts), from "settings" in the input:
- Turning sources on or off, Claude Code projects to read or leave out (use names from claude_projects), daily target, working hours, rounding, time zone, default task names, the AI helper (on, off, or which agent runs it: Claude Code, opencode or Pi), and project rules ("anything in acme/api is Acme Website").
- Adding a project to log time to ("add a project called Acme Website", "I also work on Internal Tools"): project_rule with only the name (and task if they give one).
- Leaving a project out ("leave out my dotfiles", "don't count my personal project", "ignore the gym on my calendar"): project_rule with ignore true, named after the project as it is on the day (or matching a repo or title when they give one). It works for every source; claude_projects only when they mean Claude Code's own project list.
- How descriptions are written ("write them in past tense", "make descriptions longer", "always put the ticket key first", "write them like: …"): descriptions, with only what they asked to change. Their own instructions go in their words; examples are descriptions they give as a model.
- How their standup is written ("make my standup bullet points", "keep the standup short", "leave meetings out of my standup", "write it like: …"): standup, with only what they asked to change.
- Export formats ("add a Harvest export with hours as h:mm", "a Slack export, one line per row", "make harvest what ctrl+y copies"): export_format with the whole format (an existing one from exports, with only what they asked to change), remove_export, copy_default. Built-in csv, tsv, md and json can't be changed or named. Columns are only the listed fields; text lines only fill in {field}s.
- Something they want kept in mind that no setting covers ("remember that I write for a non-technical audience", "remember my ticket keys come first"): remember, in their words, shortened to one line. A style, a rule, a task name or a limit is a setting, so use that instead. "forget …" or "stop remembering …": forget, with the memory's words from memories.
- Durations are like "7h30m", "45m"; working hours "HH:MM-HH:MM".
- Google Calendar and the ERP need a sign-in in the browser: use connect (with the ERP's address when they give one) and disconnect. Never ask for passwords, tokens or private calendar links.
- "Send <project> to <task>" or "log <project> against <task>": erp_task with the words they used to name the task as search.
- A request about settings changes no blocks, and a correction to the day changes no settings.
- Rebuilding the day from the latest activity ("refresh", "pull in the new activity", "start the day over"): rebuild true, no ops and no settings.
- "earlier" holds the last few things they said and your replies; use it to understand short follow-ups ("yes", "the second one").`;

export const correctionSchema = z.object({
  ops: z.array(editOpSchema),
  settings: z.array(aiSettingOpSchema).optional().describe("Changes to Clockout's settings"),
  rebuild: z
    .boolean()
    .optional()
    .describe("Draft the day again from the latest activity, dropping corrections"),
  reply: z.string().describe("One short sentence describing the change, or empty"),
});
export type Correction = Omit<z.infer<typeof correctionSchema>, "settings"> & {
  settings?: SettingOp[];
};

/** What's on this machine besides the config, for the settings the AI sees. */
export interface SettingsFacts {
  googleConnected: boolean;
  erpConnected: boolean;
  claudeProjects: (ClaudeProjectRef & { recent?: number })[];
}

/** A turn of the chat, so follow-ups make sense to a CLI that remembers nothing. */
export interface Turn {
  said: string;
  reply: string;
}

/**
 * Clockout's settings as the AI sees them: what's on, names and numbers. No credentials, no
 * private calendar link, no folder paths.
 */
export function settingsContext(config: Config, facts: SettingsFacts) {
  const has = (type: string) => config.sources.some((s) => s.type === type);
  const claude = config.sources.find((s) => s.type === "claude-code");
  const excluded = claude?.type === "claude-code" ? (claude.exclude ?? []) : [];
  return {
    sources: {
      "claude-code": has("claude-code"),
      pi: has("pi"),
      codex: has("codex"),
      opencode: has("opencode"),
      antigravity: has("antigravity"),
      github: has("github"),
      "google-calendar": has("google-calendar"),
      google_signed_in: facts.googleConnected,
      calendar_feed: has("calendar"),
    },
    claude_projects: facts.claudeProjects.map((p) => ({
      name: p.name,
      on: has("claude-code") && !excluded.includes(p.folder),
      ...(p.recent ? { sessions_this_week: p.recent } : {}),
    })),
    day: config.day,
    timezone: config.me.timezone,
    task_names: config.tasks,
    ai_helper: config.ai.backend,
    descriptions: config.descriptions,
    standup: config.standup,
    memories: config.memories,
    // A file a destination writes to is set by hand and stays out of what the AI sees.
    exports: config.exports.map((e) => (e.to && "file" in e.to ? { ...e, to: undefined } : e)),
    project_rules: config.projects.map((p) => ({
      name: p.name,
      ...(p.task ? { task: p.task } : {}),
      ...(p.ignore ? { ignore: true } : {}),
      ...p.match,
    })),
    erp: config.timesheet
      ? {
          site: targetHost(config.timesheet) ?? "a program on this machine",
          signed_in: facts.erpConnected,
          sends: config.timesheet.map.map((m) => ({
            project: m.project,
            ...(m.task ? { task: m.task } : {}),
            to: m.label ?? m.erp_task,
          })),
        }
      : null,
  };
}

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
  opts: { facts?: SettingsFacts; earlier?: Turn[] } = {},
): Promise<Correction> {
  const local = localCorrection(text);
  if (local) return local;
  refuseSecrets(text);
  const facts = opts.facts ?? { googleConnected: false, erpConnected: false, claudeProjects: [] };
  const prompt = JSON.stringify(
    {
      day: correctionContext(day, config),
      settings: settingsContext(config, facts),
      ...(opts.earlier?.length ? { earlier: opts.earlier } : {}),
      said: text,
    },
    null,
    2,
  );
  const answer = await backend.complete({
    system: SYSTEM,
    prompt: redactSecrets(prompt),
    schema: correctionSchema,
  });
  checkAnswer(answer, day, config);
  return answer;
}

/**
 * Throws when the AI's edits wouldn't apply to this day (ids that aren't there, times that don't
 * fit) or would put something that looks like a token on the timesheet: better to say so now
 * than to show a proposal that fails, or lands, when accepted.
 */
function checkAnswer(answer: Correction, day: Day, config: Config): void {
  const words = [answer.reply, ...answer.ops.flatMap((o) => Object.values(o))].filter(
    (w): w is string => typeof w === "string",
  );
  if (words.some(hasSecret))
    throw new Error(
      "The AI's answer had something that looks like a token in it, so it wasn't used. Try saying it differently.",
    );
  const changes = answer.ops.filter((o) => o.op !== "clarify");
  if (changes.length === 0) return;
  const { errors } = applyEdits(day, changes, config);
  if (errors.length)
    throw new Error("The AI's answer didn't fit this day. Try saying it differently.", {
      cause: new Error(errors.join(" ")),
    });
}

const URLS = /\b(?:https?|webcal):\/\/[^\s<>"']+/gi;

/** A private calendar address: anyone holding it can read the calendar. */
function isCalendarFeed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "webcal:" || /\.ics$/i.test(u.pathname) || /\/ical\//i.test(u.pathname);
  } catch {
    return false;
  }
}

const SERVICE = "(?:my\\s+|the\\s+)?(erp|google(?:\\s+calendar)?|calendar)";
const CONNECT = new RegExp(
  `^(?:connect|sign\\s+in\\s+to)\\s+${SERVICE}(?:\\s+(?:at\\s+)?(\\S+))?[.!]?$`,
  "i",
);
const DISCONNECT = new RegExp(`^(?:disconnect|sign\\s+out\\s+of)\\s+${SERVICE}[.!]?$`, "i");
const REBUILD =
  /^(?:refresh|rebuild|reload|redraft|start\s+over)(?:\s+(?:the\s+|this\s+|my\s+)?day)?[.!]?$/i;

/**
 * What can be done without the AI: a pasted private calendar link (which must never reach the
 * AI), plain "connect erp <address>" / "disconnect google", and "refresh". Null for anything else.
 */
export function localCorrection(text: string): Correction | null {
  const feed = text.match(URLS)?.find(isCalendarFeed);
  if (feed)
    return {
      ops: [],
      settings: [{ op: "calendar_feed", url: feed.replace(/^webcal:/i, "https:") }],
      reply: "Read your calendar from its private link",
    };
  const said = text.trim();
  if (REBUILD.test(said))
    return { ops: [], rebuild: true, reply: "Rebuild the day from the latest activity" };
  const which = (s: string) => (s.toLowerCase() === "erp" ? "erp" : "google");
  const c = CONNECT.exec(said);
  if (c?.[1]) {
    const service = which(c[1]);
    return {
      ops: [],
      settings: [{ op: "connect", service, ...(service === "erp" && c[2] ? { url: c[2] } : {}) }],
      reply: service === "erp" ? "Connect your ERP" : "Connect Google Calendar",
    };
  }
  const d = DISCONNECT.exec(said);
  if (d?.[1]) {
    const service = which(d[1]);
    return {
      ops: [],
      settings: [{ op: "disconnect", service }],
      reply: service === "erp" ? "Sign out of your ERP" : "Sign out of Google Calendar",
    };
  }
  return null;
}

/** Throws when the text holds something that looks like a token or key, so it's never sent. */
export function refuseSecrets(text: string): void {
  if (hasSecret(text))
    throw new Error(
      "That looks like a password or token, so it wasn't sent to the AI. Clockout never needs one: sign-ins happen in your browser.",
    );
}

export type { EditOp };
