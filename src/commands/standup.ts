import clipboard from "clipboardy";
import { logError } from "../log";
import { buildStandup } from "../standup";
import { type AppContext, appContext, commandAi, resolveDate } from "./context";
import { destinationExport, saveToDestination } from "./dest";

export interface StandupOptions {
  /** What's in your way, as you'd say it; repeatable. Never guessed. */
  blocker?: string[];
  /** commander sets this to false for --no-ai */
  ai?: boolean;
  /** commander sets this to false for --no-copy */
  copy?: boolean;
  /** An export format with a destination: the standup goes there as well. */
  to?: string;
  dryRun?: boolean;
  yes?: boolean;
  interactive?: boolean;
}

/** `clockout standup [date]`: prints the standup, and copies it when run in a terminal. */
export async function runStandup(
  dateInput: string | undefined,
  opts: StandupOptions,
  app?: AppContext,
) {
  const { config, store } = app ?? (await appContext());
  const tz = config.me.timezone;
  const date = resolveDate(dateInput, tz);
  const ai = await commandAi(config, opts.ai);
  const standup = await buildStandup(date, resolveDate(undefined, tz), config, store, {
    blockers: opts.blocker ?? [],
    ai,
    log: logError,
  });
  for (const w of standup.warnings) console.error(`warning: ${w}`);
  if (opts.to) {
    // The same text, written where that export's destination says (a daily note, a tool).
    await saveToDestination(config, destinationExport(config, opts.to), standup.text, date, {
      ...opts,
      kind: "standup",
    });
    return;
  }
  process.stdout.write(`${standup.text}\n`);
  if (opts.copy === false || !process.stdout.isTTY) return;
  try {
    await clipboard.write(standup.text);
    console.error("Copied to the clipboard.");
  } catch {
    console.error("Couldn't reach the clipboard; copy it from above.");
  }
}
