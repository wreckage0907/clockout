import { writeFile } from "node:fs/promises";
import { chooseBackend } from "../ai";
import { openDay } from "../collect";
import { addDays } from "../core/time";
import { timesheetRows } from "../core/timesheet";
import type { TimesheetRow } from "../core/types";
import { toCsv, toMarkdown, toTsv } from "../export/formats";
import { type AppContext, appContext, resolveDate } from "./context";

export interface ExportOptions {
  format?: string;
  out?: string;
  from?: string;
  to?: string;
  ai?: boolean;
}

const FORMATS = ["csv", "md", "tsv", "json"] as const;
type Format = (typeof FORMATS)[number];
const MAX_DAYS = 62;

/** `clockout export [date]` or `clockout export --from 2026-10-01 --to 2026-10-31 --format csv --out oct.csv` */
export async function runExport(
  dateInput: string | undefined,
  opts: ExportOptions,
  app?: AppContext,
) {
  const { config, store } = app ?? (await appContext());
  const format = (opts.format ?? "csv") as Format;
  if (!FORMATS.includes(format))
    throw new Error(`Unknown format "${opts.format}". Use ${FORMATS.join(", ")}.`);

  const tz = config.me.timezone;
  const from = resolveDate(opts.from ?? dateInput, tz);
  const to = resolveDate(opts.to ?? opts.from ?? dateInput, tz);
  if (to < from) throw new Error(`--to (${to}) is before --from (${from}).`);

  const dates: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    dates.push(d);
    if (dates.length > MAX_DAYS)
      throw new Error(`That's more than ${MAX_DAYS} days; export a shorter range.`);
  }

  const ai = opts.ai === false ? null : await chooseBackend(config);
  const rows: TimesheetRow[] = [];
  let open = 0;
  for (const date of dates) {
    const { stored, warnings } = await openDay(date, config, store, { ai });
    for (const w of warnings) console.error(`warning (${date}): ${w}`);
    rows.push(...timesheetRows(stored.day, config));
    open += stored.day.questions.length;
  }

  const text =
    format === "csv"
      ? toCsv(rows)
      : format === "tsv"
        ? `${toTsv(rows)}\n`
        : format === "md"
          ? `${toMarkdown(rows)}\n`
          : `${JSON.stringify(
              rows.map(({ sendTo: _, ...r }) => r),
              null,
              2,
            )}\n`;

  if (opts.out) {
    await writeFile(opts.out, text);
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
