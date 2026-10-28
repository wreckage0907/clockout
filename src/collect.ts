import { homedir } from "node:os";
import { summarizeDay } from "./ai/summarize";
import type { LlmBackend } from "./ai/types";
import type { Config } from "./config/schema";
import { buildDay } from "./core/blocks";
import { applyEdits } from "./core/edits";
import { cleanText } from "./core/text";
import { dayRange } from "./core/time";
import type { Activity, Day } from "./core/types";
import { getSource } from "./sources";
import type { Source, SourceContext } from "./sources/types";
import type { DayStore, StoredDay } from "./store/json-store";

/** Where a failure's full details go (the error log); tests leave it out. */
export type LogError = (where: string, err: unknown) => unknown;

export interface Collected {
  activities: Activity[];
  /** One line per source that failed; the day is built from the rest. */
  warnings: string[];
  /** Source ids that returned successfully. */
  ok: Set<string>;
}

/** Runs every configured source for the local day, in parallel. */
export type SourceLookup = (type: string) => Source | undefined;

export async function collect(
  date: string,
  config: Config,
  ctx: Partial<Omit<SourceContext, "config">> = {},
  lookup: SourceLookup = getSource,
  log?: LogError,
): Promise<Collected> {
  const range = dayRange(date, config.me.timezone);
  const warnings: string[] = [];
  const full: SourceContext = {
    config,
    homeDir: homedir(),
    env: process.env,
    warn: (message) => {
      if (!warnings.includes(message)) warnings.push(message);
    },
    ...ctx,
  };
  const results = await Promise.allSettled(
    config.sources.map(async (cfg) => {
      const source = lookup(cfg.type);
      if (!source) throw new Error(`unknown source type "${cfg.type}"`);
      const out: Activity[] = [];
      for await (const a of source.collect(range, cfg, full)) out.push(a);
      return { id: source.id, out };
    }),
  );
  const activities: Activity[] = [];
  const ok = new Set<string>();
  results.forEach((r, i) => {
    if (r.status === "fulfilled") {
      // Not push(...out): a huge day overflows the call stack.
      for (const a of r.value.out) activities.push(cleaned(a));
      ok.add(r.value.id);
    } else {
      warnings.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
      log?.(`source ${config.sources[i]?.type ?? "?"}`, r.reason);
    }
  });
  return { activities, warnings, ok };
}

/** Words from outside (titles, branches) as one line of plain text, before they reach the screen. */
function cleaned(a: Activity): Activity {
  const out = { ...a };
  for (const k of ["title", "project", "repo", "branch"] as const) {
    const v = out[k];
    if (v !== undefined) out[k] = cleanText(v);
  }
  return out;
}

/** Sources whose local logs get cleaned up; an empty result for an old day means "gone", not "nothing happened". */
const DELETES_OLD_LOGS = new Set(["claude-code"]);

export interface OpenedDay {
  stored: StoredDay;
  warnings: string[];
  /** True when the day has your corrections (replayed on fresh activity where possible). */
  kept: boolean;
  /** Newer activity couldn't be replayed under your corrections; rebuilding (`refresh`) picks it up. */
  stale?: boolean;
}

/**
 * The day to show: the saved one if you've corrected it (unless `refresh`), otherwise rebuilt
 * from fresh activity. Evidence from sources that fail or come back empty is kept from the
 * previous save, so a day survives agents deleting their logs.
 */
export async function openDay(
  date: string,
  config: Config,
  store: DayStore,
  opts: {
    refresh?: boolean;
    ctx?: Partial<Omit<SourceContext, "config">>;
    /** Writes better summaries when given; failures fall back to the heuristic ones. */
    ai?: LlmBackend | null;
    /** Overrides which implementation runs for a source type (test and prototype hook). */
    sources?: SourceLookup;
    log?: LogError;
  } = {},
): Promise<OpenedDay> {
  const existing = await store.load(date);
  const corrected = existing && existing.edits.length > 0 && !opts.refresh ? existing : null;

  const fresh = await collect(date, config, opts.ctx, opts.sources, opts.log);
  // A folder whose repo one source knows (Codex records it; a folder deleted since the day was
  // last built can't say it any more) has that repo for every source, so the same work is one
  // project, and stays the same project each time the day is opened.
  const knownRepo = new Map(
    [...(existing?.activities ?? []), ...fresh.activities].flatMap((a) =>
      a.cwd && a.repo ? [[a.cwd, a.repo] as const] : [],
    ),
  );
  fresh.activities = fresh.activities.map((a) => {
    const repo = !a.repo && a.cwd ? knownRepo.get(a.cwd) : undefined;
    return repo ? { ...a, repo } : a;
  });
  const freshSources = new Set(fresh.activities.map((a) => a.source));
  // Only sources still turned on: one you turned off takes its evidence with it.
  const configured = new Set<string>(config.sources.map((s) => s.type));
  const carried = (existing?.activities ?? []).filter(
    (a) =>
      configured.has(a.source) &&
      (!fresh.ok.has(a.source) || (!freshSources.has(a.source) && DELETES_OLD_LOGS.has(a.source))),
  );
  const activities = [...fresh.activities, ...carried];
  const draft = buildDay(date, activities, config);
  const summaryCache = { ...existing?.summaryCache };
  const warnings = [...fresh.warnings];
  if (opts.ai) {
    try {
      const summaries = await summarizeDay(
        draft,
        opts.ai,
        summaryCache,
        config.descriptions,
        config.memories,
      );
      for (const b of draft.blocks) b.summary = summaries.get(b.id) ?? b.summary;
    } catch (err) {
      warnings.push(`${(err as Error).message} Using session and PR titles instead.`);
      opts.log?.(`AI helper ${opts.ai.label}`, err);
    }
  }

  let day = draft;
  let history: Day[] = [];
  if (corrected) {
    const replayed = replayEdits(corrected, draft, config);
    if (!replayed) {
      warnings.push("There's newer activity that can't be merged under your corrections.");
      return { stored: corrected, warnings, kept: true, stale: true };
    }
    if (sameBlocks(replayed.day, corrected.day)) return { stored: corrected, warnings, kept: true };
    ({ day, history } = replayed);
  }

  const stored: StoredDay = {
    version: 1,
    date,
    collectedAt: new Date().toISOString(),
    activities,
    day,
    history,
    edits: corrected?.edits ?? [],
    summaryCache,
    // What was sent to the timesheet system stays known, even when the day is rebuilt.
    ...(existing?.pushed ? { pushed: existing.pushed } : {}),
    ...(existing?.pushedAt ? { pushedAt: existing.pushedAt } : {}),
  };
  // Not over a correction (or a send) that landed while this was collecting: that one wins.
  const newer = await store.saveIfUnchanged(stored, existing);
  if (newer) return { stored: newer, warnings, kept: true };
  return { stored, warnings, kept: !!corrected };
}

/**
 * Re-applies saved corrections to a freshly built draft, so new activity shows up under them.
 * Only when every block of the original draft is still there with the same id, start and
 * project (new blocks may only be added); otherwise ids could point at the wrong blocks.
 */
function replayEdits(
  saved: StoredDay,
  draft: Day,
  config: Config,
): { day: Day; history: Day[] } | null {
  const original = saved.history[0];
  if (!original) return null;
  const same = original.blocks.every((o) => {
    const b = draft.blocks.find((x) => x.id === o.id);
    return b && b.start.getTime() === o.start.getTime() && b.project === o.project;
  });
  if (!same) return null;
  let day = draft;
  const history: Day[] = [];
  for (const record of saved.edits) {
    const r = applyEdits(day, record.ops, config);
    if (r.errors.length) return null;
    history.push(day);
    day = r.day;
  }
  return { day, history };
}

function sameBlocks(a: Day, b: Day): boolean {
  const key = (d: Day) =>
    JSON.stringify(
      d.blocks.map((x) => [x.id, x.start, x.end, x.project, x.task, x.summary, x.confirmed]),
    );
  return key(a) === key(b);
}
