import { chooseBackend } from "../ai";
import { parseCorrection } from "../ai/edits";
import { openDay } from "../collect";
import { describeEdits } from "../core/edits";
import { commitEdits, undoEdit } from "../corrections";
import { renderDay } from "../export/text";
import { type AppContext, appContext, resolveDate } from "./context";

export interface EditOptions {
  date?: string;
  dryRun?: boolean;
}

/** `clockout edit "the gap was lunch, I skipped the design sync"` */
export async function runEdit(text: string, opts: EditOptions, app?: AppContext) {
  const { config, store } = app ?? (await appContext());
  const backend = await chooseBackend(config);
  if (!backend) {
    throw new Error(
      "Corrections in plain words need Claude Code. Install it, or set ai.backend in your config.",
    );
  }
  const date = resolveDate(opts.date, config.me.timezone);
  const { stored } = await openDay(date, config, store, { ai: backend });

  const { ops, reply } = await parseCorrection(text, stored.day, config, backend);
  const changes = ops.filter((o) => o.op !== "clarify");
  for (const line of describeEdits(stored.day, ops)) console.log(`  ${line}`);
  if (changes.length === 0) {
    if (reply) console.log(reply);
    return;
  }
  if (opts.dryRun) {
    console.log("\n(dry run: nothing saved)");
    return;
  }
  const result = await commitEdits(stored, ops, config, store, text);
  if (result.errors.length) {
    throw new Error(`Couldn't apply that: ${result.errors.join(" ")}`);
  }
  if (reply) console.log(`\n${reply}`);
  console.log(`\n${renderDay(result.stored.day, config)}`);
}

export async function runUndo(opts: { date?: string }, app?: AppContext) {
  const { config, store } = app ?? (await appContext());
  const date = resolveDate(opts.date, config.me.timezone);
  const stored = await store.load(date);
  const restored = stored && (await undoEdit(stored, store));
  if (!restored) {
    console.log(`Nothing to undo for ${date}.`);
    return;
  }
  console.log(renderDay(restored.day, config));
}
