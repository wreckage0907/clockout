import { homedir } from "node:os";
import type { Config } from "./config/schema";
import { buildDay } from "./core/blocks";
import { dayRange } from "./core/time";
import type { Activity } from "./core/types";
import { getSource } from "./sources";
import type { SourceContext } from "./sources/types";
import type { DayStore, StoredDay } from "./store/json-store";

export interface Collected {
  activities: Activity[];
  /** One line per source that failed; the day is built from the rest. */
  warnings: string[];
  /** Source ids that returned successfully. */
  ok: Set<string>;
}

/** Runs every configured source for the local day, in parallel. */
export async function collect(
  date: string,
  config: Config,
  ctx: Partial<Omit<SourceContext, "config">> = {},
): Promise<Collected> {
  const range = dayRange(date, config.me.timezone);
  const full: SourceContext = { config, homeDir: homedir(), env: process.env, ...ctx };
  const results = await Promise.allSettled(
    config.sources.map(async (cfg) => {
      const source = getSource(cfg.type);
      if (!source) throw new Error(`unknown source type "${cfg.type}"`);
      const out: Activity[] = [];
      for await (const a of source.collect(range, cfg, full)) out.push(a);
      return { id: source.id, out };
    }),
  );
  const activities: Activity[] = [];
  const warnings: string[] = [];
  const ok = new Set<string>();
  for (const r of results) {
    if (r.status === "fulfilled") {
      activities.push(...r.value.out);
      ok.add(r.value.id);
    } else {
      warnings.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
    }
  }
  return { activities, warnings, ok };
}

/** Sources whose local logs get cleaned up; an empty result for an old day means "gone", not "nothing happened". */
const DELETES_OLD_LOGS = new Set(["claude-code"]);

export interface OpenedDay {
  stored: StoredDay;
  warnings: string[];
  /** True when the day has corrections and was not rebuilt from fresh activity. */
  kept: boolean;
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
  opts: { refresh?: boolean; ctx?: Partial<Omit<SourceContext, "config">> } = {},
): Promise<OpenedDay> {
  const existing = await store.load(date);
  if (existing && existing.edits.length > 0 && !opts.refresh) {
    return { stored: existing, warnings: [], kept: true };
  }
  const fresh = await collect(date, config, opts.ctx);
  const freshSources = new Set(fresh.activities.map((a) => a.source));
  const carried = (existing?.activities ?? []).filter(
    (a) =>
      !fresh.ok.has(a.source) || (!freshSources.has(a.source) && DELETES_OLD_LOGS.has(a.source)),
  );
  const activities = [...fresh.activities, ...carried];
  const stored: StoredDay = {
    version: 1,
    date,
    collectedAt: new Date().toISOString(),
    activities,
    day: buildDay(date, activities, config),
    history: [],
    edits: [],
  };
  await store.save(stored);
  return { stored, warnings: fresh.warnings, kept: false };
}
