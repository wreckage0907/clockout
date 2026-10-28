import { homedir } from "node:os";
import { confirm, isCancel } from "@clack/prompts";
import { chooseBackend } from "../ai";
import { parseCorrection } from "../ai/edits";
import type { LlmBackend } from "../ai/types";
import { openDay } from "../collect";
import { saveConfig } from "../config/load";
import { resolvePaths, tildify } from "../config/paths";
import { applySettings, describeSettings, type SettingOp } from "../config/setting-ops";
import { describeEdits } from "../core/edits";
import { cleanText } from "../core/text";
import { commitEdits, undoEdit } from "../corrections";
import { renderDay } from "../export/text";
import { logError } from "../log";
import { listClaudeProjects } from "../sources/claude-code/paths";
import { type AppContext, appContext, noAiMessage, resolveDate } from "./context";

export interface EditOptions {
  date?: string;
  dryRun?: boolean;
  /** Save settings changes without asking. */
  yes?: boolean;
}

/** What a test can answer for: whether there's a terminal to ask on, and the answer. */
export interface EditDeps {
  interactive?: boolean;
  ask?: (message: string) => Promise<boolean>;
}

/** Sign-ins and ERP task picks need the app; a command can only write the settings around them. */
const APART = new Set(["connect", "disconnect", "erp_task"]);

/**
 * `clockout edit "the gap was lunch, I skipped the design sync"`. Settings said the same way
 * ("remember the reader isn't technical") are applied to config.toml too, once you say yes.
 */
export async function runEdit(
  text: string,
  opts: EditOptions,
  app?: AppContext & EditDeps & { backend?: LlmBackend },
) {
  const { config, store } = app ?? (await appContext());
  const backend = app?.backend ?? (await chooseBackend(config)).backend;
  if (!backend) throw new Error(noAiMessage(config));
  const date = resolveDate(opts.date, config.me.timezone);
  const { stored } = await openDay(date, config, store, { ai: backend, log: logError });

  const { ops, settings = [], reply } = await parseCorrection(text, stored.day, config, backend);
  const changes = ops.filter((o) => o.op !== "clarify");
  // What the AI wrote can carry text from other people's titles: no escape codes on the terminal.
  for (const line of [...describeEdits(stored.day, ops), ...describeSettings(settings)])
    console.log(`  ${cleanText(line)}`);
  if (changes.length === 0 && settings.length === 0) {
    if (reply) console.log(cleanText(reply));
    return;
  }
  if (opts.dryRun) {
    console.log("\n(dry run: nothing saved)");
    return;
  }

  if (settings.length) {
    // Settings decide what is read and where text goes: never saved without a yes.
    const next = await prepareSettings(settings, config);
    const interactive = app?.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
    if (!opts.yes && !interactive)
      throw new Error(
        "Add --yes to save settings changes without being asked, or run it in a terminal to be asked.",
      );
    const ask = app?.ask ?? askYes;
    if (opts.yes || (await ask(`Save these to ${tildify(resolvePaths().configFile)}?`)))
      await saveSettings(next, settings);
    else console.log("Settings not saved.");
  }

  if (changes.length === 0) {
    if (reply) console.log(`\n${cleanText(reply)}`);
    return;
  }
  const result = await commitEdits(stored, changes, config, store, text);
  if (result.errors.length) {
    throw new Error(`Couldn't apply that: ${result.errors.join(" ")}`);
  }
  if (reply) console.log(`\n${cleanText(reply)}`);
  console.log(`\n${renderDay(result.stored.day, config)}`);
}

async function askYes(message: string): Promise<boolean> {
  const answer = await confirm({ message });
  return !isCancel(answer) && answer;
}

/** Works out what the settings would do, and says why when they don't fit. Nothing is written. */
async function prepareSettings(settings: readonly SettingOp[], config: AppContext["config"]) {
  const projects = settings.some((s) => s.op === "claude_projects")
    ? await listClaudeProjects({ homeDir: homedir(), env: process.env }, new Date(0)).catch(
        () => [],
      )
    : [];
  const r = applySettings(config, settings, projects);
  if (r.errors.length) throw new Error(`Couldn't save that: ${r.errors.join(" ")}`);
  return r.config;
}

/** Writes the settings, and says what it couldn't do from here. */
async function saveSettings(next: AppContext["config"], settings: readonly SettingOp[]) {
  await saveConfig(resolvePaths().configFile, next);
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
