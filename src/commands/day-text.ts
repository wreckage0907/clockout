import type { LlmBackend } from "../ai/types";
import { openDay } from "../collect";
import type { Config } from "../config/schema";
import { exportNames, findExport, render, rowsFor } from "../export/named";
import { logError } from "../log";
import type { DayStore } from "../store/json-store";

// One day's rows as an export format renders them, for the callers that need the text without
// printing it (a destination, a scheduled run).

export interface DayText {
  text: string;
  rows: number;
  /** Questions still open on the day: its sheet is partial until they're answered. */
  open: number;
}

export async function dayText(
  format: string,
  date: string,
  config: Config,
  store: DayStore,
  ai: LlmBackend | null,
): Promise<DayText> {
  const choice = findExport(format, config);
  if (!choice)
    throw new Error(`Unknown format "${format}". Use ${exportNames(config).join(", ")}.`);
  const { stored } = await openDay(date, config, store, { ai, log: logError });
  const rows = rowsFor(choice, stored.day, config);
  return {
    text: render(choice, rows, config),
    rows: rows.length,
    open: stored.day.questions.length,
  };
}
