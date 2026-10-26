import { homedir } from "node:os";
import { chooseBackend } from "../ai";
import { parseCorrection } from "../ai/edits";
import type { LlmBackend } from "../ai/types";
import { openDay } from "../collect";
import { saveConfig } from "../config/load";
import { resolvePaths, tildify } from "../config/paths";
import { applySettings, describeSettings, type SettingOp } from "../config/setting-ops";
import { describeEdits } from "../core/edits";
import { commitEdits, undoEdit } from "../corrections";
import { renderDay } from "../export/text";
import { logError } from "../log";
import { listClaudeProjects } from "../sources/claude-code/paths";
import { type AppContext, appContext, noAiMessage, resolveDate } from "./context";

export interface EditOptions {
  date?: string;
  dryRun?: boolean;
}

/** Sign-ins and ERP task picks need the app; a command can only write the settings around them. */
const APART = new Set(["connect", "disconnect", "erp_task"]);

/**
 * `clockout edit "the gap was lunch, I skipped the design sync"`. Settings said the same way
 * ("remember the reader isn't technical") are applied to config.toml too.
 */
export async function runEdit(
  text: string,
  opts: EditOptions,
  app?: AppContext & { backend?: LlmBackend },
) {
  const { config, store } = app ?? (await appContext());
  const backend = app?.backend ?? (await chooseBackend(config)).backend;
  if (!backend) throw new Error(noAiMessage(config));
  const date = resolveDate(opts.date, config.me.timezone);
  const { stored } = await openDay(date, config, store, { ai: backend, log: logError });

  const { ops, settings = [], reply } = await parseCorrection(text, stored.day, config, backend);
  const changes = ops.filter((o) => o.op !== "clarify");
  for (const line of [...describeEdits(stored.day, ops), ...describeSettings(settings)])
    console.log(`  ${line}`);
  if (changes.length === 0 && settings.length === 0) {
    if (reply) console.log(reply);
    return;
  }
  if (opts.dryRun) {
    console.log("\n(dry run: nothing saved)");
    return;
  }

  if (settings.length) await saveSettings(settings, config);

  if (changes.length === 0) {
    if (reply) console.log(`\n${reply}`);
    return;
  }
  const result = await commitEdits(stored, changes, config, store, text);
  if (result.errors.length) {
    throw new Error(`Couldn't apply that: ${result.errors.join(" ")}`);
  }
  if (reply) console.log(`\n${reply}`);
  console.log(`\n${renderDay(result.stored.day, config)}`);
}

/** Applies settings operations from a command, and says what it couldn't do from here. */
async function saveSettings(settings: readonly SettingOp[], config: AppContext["config"]) {
  const projects = settings.some((s) => s.op === "claude_projects")
    ? await listClaudeProjects({ homeDir: homedir(), env: process.env }, new Date(0)).catch(
        () => [],
      )
    : [];
  const r = applySettings(config, settings, projects);
  if (r.errors.length) throw new Error(`Couldn't save that: ${r.errors.join(" ")}`);
  await saveConfig(resolvePaths().configFile, r.config);
  const apart = settings.filter((s) => APART.has(s.op)).map((s) => s.op);
  if (apart.length)
    console.log(
      `\nThat also needs ${[...new Set(apart)].join(" and ")} from the app: open \`clockout\` and say it there.`,
    );
  console.log(`\nSaved to ${tildify(resolvePaths().configFile)}.`);
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
