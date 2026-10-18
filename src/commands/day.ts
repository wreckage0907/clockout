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
  /** Print the table instead of opening the review screen. */
  plain?: boolean;
  /** Use bundled sample data instead of your own. */
  demo?: boolean;
}

export async function runDay(dateInput: string | undefined, opts: DayOptions, app?: AppContext) {
  const ctx = app ?? (await appContext({ demo: opts.demo }));
  const { config, store, demo } = ctx;
  const date = demo?.date ?? resolveDate(dateInput, config.me.timezone);
  const ai = opts.ai === false ? null : await chooseBackend(config);
  const interactive = !opts.md && !opts.csv && !opts.json && !opts.plain;
  if (interactive && process.stdin.isTTY && process.stdout.isTTY) {
    const { runTui } = await import("../tui/run");
    await runTui(date, ctx, ai);
    return;
  }
  const { stored, warnings, kept } = await openDay(date, config, store, {
    refresh: opts.refresh,
    ai,
    ...(demo ? { sources: demo.sources, ctx: demo.ctx } : {}),
  });
  if (demo)
    console.error("Demo: a made-up day (Thu 16 Oct 2026). Run `clockout init` to use your own.\n");
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
