import { loadConfig } from "../config/load";
import { resolvePaths, tildify } from "../config/paths";
import type { Config } from "../config/schema";
import { addDays, isDate, localDate } from "../core/time";
import { DayStore } from "../store/json-store";

export interface AppContext {
  config: Config;
  store: DayStore;
}

/** Loads config and store, or explains how to create the config. */
export async function appContext(): Promise<AppContext> {
  const paths = resolvePaths();
  const config = await loadConfig(paths.configFile);
  if (!config) {
    throw new Error(`No config at ${tildify(paths.configFile)}. Run \`clockout init\` first.`);
  }
  return { config, store: new DayStore(paths.dataDir) };
}

/** "today", "yesterday", "-2" (days ago) or "YYYY-MM-DD" → local date in `tz`. */
export function resolveDate(input: string | undefined, tz: string, now = new Date()): string {
  const today = localDate(now, tz);
  if (!input || input === "today") return today;
  if (input === "yesterday") return addDays(today, -1);
  if (/^-\d+$/.test(input)) return addDays(today, Number(input));
  if (isDate(input)) return input;
  throw new Error(`Can't read the date "${input}". Use today, yesterday, -2 or YYYY-MM-DD.`);
}
