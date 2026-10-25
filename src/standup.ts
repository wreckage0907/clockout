import { writeStandup } from "./ai/standup";
import type { LlmBackend } from "./ai/types";
import { collect, type LogError, openDay, type SourceLookup } from "./collect";
import type { Config } from "./config/schema";
import {
  branchesWithoutPr,
  dayItems,
  type OpenWork,
  plainSections,
  previousWorkingDay,
  renderStandup,
  type StandupFacts,
  type StandupSections,
  todaysMeetings,
} from "./core/standup";
import { openWork } from "./sources/github/open-work";
import type { SourceContext } from "./sources/types";
import type { DayStore } from "./store/json-store";

const CALENDARS = new Set(["calendar", "google-calendar"]);

export interface Standup {
  text: string;
  facts: StandupFacts;
  /** One line per thing that couldn't be read; the standup is written from the rest. */
  warnings: string[];
  /** Whether the AI wrote it (false: the plain template). */
  byAi: boolean;
}

/**
 * The standup for `date` (today unless you ask for another): the previous working day's saved
 * day with your corrections, today's calendar and, for today, what's still open on GitHub.
 * Blockers are only `blockers`, never guessed.
 */
export async function buildStandup(
  date: string,
  today: string,
  config: Config,
  store: DayStore,
  opts: {
    blockers?: string[];
    ai?: LlmBackend | null;
    ctx?: Partial<Omit<SourceContext, "config">>;
    sources?: SourceLookup;
    /** Open work from GitHub; read with your token when left out. */
    openWork?: () => Promise<OpenWork>;
    log?: LogError;
  } = {},
): Promise<Standup> {
  const tz = config.me.timezone;
  const warnings: string[] = [];
  const before = previousWorkingDay(date);
  const calendars = { ...config, sources: config.sources.filter((s) => CALENDARS.has(s.type)) };
  const github = config.sources.some((s) => s.type === "github") && date === today;
  const [previous, calendar, open] = await Promise.all([
    openDay(before, config, store, {
      ...(opts.ai ? { ai: opts.ai } : {}),
      ...(opts.ctx ? { ctx: opts.ctx } : {}),
      ...(opts.sources ? { sources: opts.sources } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    }),
    calendars.sources.length
      ? collect(date, calendars, opts.ctx, opts.sources, opts.log)
      : Promise.resolve({ activities: [], warnings: [], ok: new Set<string>() }),
    github
      ? (opts.openWork ?? (() => openWork(opts.ctx?.env ?? process.env, tz)))().catch(
          (err: unknown) => {
            warnings.push(err instanceof Error ? err.message : String(err));
            opts.log?.("standup open work", err);
            return null;
          },
        )
      : Promise.resolve(null),
  ]);
  warnings.push(...previous.warnings.map((w) => `${before}: ${w}`), ...calendar.warnings);

  const day = previous.stored.day;
  const facts: StandupFacts = {
    date,
    yesterday: { date: before, items: dayItems(day, config) },
    meetings: todaysMeetings(calendar.activities, config, tz),
    prs: open?.prs ?? [],
    reviews: open?.reviews ?? [],
    branches: open ? branchesWithoutPr(day, open) : [],
    blockers: (opts.blockers ?? []).map((b) => b.trim()).filter(Boolean),
  };

  let sections: StandupSections | null = null;
  if (opts.ai) {
    try {
      sections = await writeStandup(facts, opts.ai, config.standup);
    } catch (err) {
      warnings.push(`${(err as Error).message} Using the plain standup instead.`);
      opts.log?.(`AI helper ${opts.ai.label}`, err);
    }
  }
  return {
    text: renderStandup(sections ?? plainSections(facts), facts, config.standup),
    facts,
    warnings,
    byAi: sections !== null,
  };
}
