import { writeFile } from "node:fs/promises";
import { openDay } from "../collect";
import { addDays } from "../core/time";
import type { TimesheetRow } from "../core/types";
import { exportNames, findExport, render, rowsFor } from "../export/named";
import { fileError } from "../files";
import { logError } from "../log";
import { type AppContext, appContext, commandAi, resolveDate } from "./context";

export interface ExportOptions {
  format?: string;
  out?: string;
  from?: string;
  to?: string;
  ai?: boolean;
}

const MAX_DAYS = 62;

/**
 * `clockout export [date]` or `clockout export --from 2026-10-01 --to 2026-10-31 --format csv --out oct.csv`.
 * The format is built in (csv, md, tsv, json) or one of yours from `[[exports]]`.
 */
export async function runExport(
  dateInput: string | undefined,
  opts: ExportOptions,
  app?: AppContext,
) {
  const { config, store } = app ?? (await appContext());
  const format = findExport(opts.format ?? "csv", config);
  if (!format)
    throw new Error(`Unknown format "${opts.format}". Use ${exportNames(config).join(", ")}.`);

  const tz = config.me.timezone;
  if (dateInput && (opts.from || opts.to))
    throw new Error(`Give a date or --from/--to, not both (got "${dateInput}" too).`);
  const today = resolveDate(undefined, tz);
  // A range may run past today (the whole month, mid-month); it stops at today.
  const end = resolveDate(opts.to ?? opts.from ?? dateInput, tz, undefined, { future: true });
  const to = end > today ? today : end;
  const from = resolveDate(opts.from ?? (opts.to ? to : dateInput), tz);
  if (to < from) throw new Error(`--to (${to}) is before --from (${from}).`);

  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    dates.push(d);
    if (dates.length > MAX_DAYS)
      throw new Error(`That's more than ${MAX_DAYS} days; export a shorter range.`);
  }

  const ai = await commandAi(config, opts.ai);
  const rows: TimesheetRow[] = [];
  let open = 0;
  for (const date of dates) {
    const { stored, warnings } = await openDay(date, config, store, { ai, log: logError });
    for (const w of warnings) console.error(`warning (${date}): ${w}`);
    rows.push(...rowsFor(format, stored.day, config));
    open += stored.day.questions.length;
  }

  const text = render(format, rows, config);

  if (opts.out) {
    await writeFile(opts.out, text).catch((err: unknown) => {
      throw fileError(opts.out ?? "", err);
    });
    console.error(`Wrote ${rows.length} row${rows.length === 1 ? "" : "s"} to ${opts.out}.`);
  } else {
    process.stdout.write(text);
  }
  if (open) {
    console.error(
      `${open} open question${open === 1 ? "" : "s"}; unconfirmed meetings aren't included. Run \`clockout\` to review.`,
    );
  }
}
