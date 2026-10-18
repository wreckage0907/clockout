import { chooseBackend } from "../ai";
import { openDay } from "../collect";
import { timesheetRows } from "../core/timesheet";
import { toCsv, toMarkdown } from "../export/formats";
import { renderDay } from "../export/text";
import { type AppContext, appContext, resolveDate } from "./context";

export interface DayOptions {
  md?: boolean;
  csv?: boolean;
  json?: boolean;
  refresh?: boolean;
  /** commander sets this to false for --no-ai */
  ai?: boolean;
}

export async function runDay(dateInput: string | undefined, opts: DayOptions, app?: AppContext) {
  const { config, store } = app ?? (await appContext());
  const date = resolveDate(dateInput, config.me.timezone);
  const ai = opts.ai === false ? null : await chooseBackend(config);
  const { stored, warnings, kept } = await openDay(date, config, store, {
    refresh: opts.refresh,
    ai,
  });
  const day = stored.day;

  for (const w of warnings) console.error(`warning: ${w}`);

  if (opts.json) {
    console.log(JSON.stringify({ ...day, rows: timesheetRows(day, config) }, null, 2));
  } else if (opts.csv) {
    process.stdout.write(toCsv(timesheetRows(day, config)));
  } else if (opts.md) {
    console.log(toMarkdown(timesheetRows(day, config)));
  } else {
    console.log(renderDay(day, config));
    if (kept) {
      console.error(
        "\nShowing your corrected day. Run with --refresh to rebuild from fresh activity (drops corrections).",
      );
    }
  }
}
