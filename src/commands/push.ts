import { autocomplete, confirm, isCancel } from "@clack/prompts";
import { openDay } from "../collect";
import { withTaskMapping } from "../config/edit";
import { loadConfig, saveConfig } from "../config/load";
import { resolvePaths } from "../config/paths";
import { type Config, targetWhere } from "../config/schema";
import { changes, describeItem, type PushPlan, type PushRow } from "../core/push";
import { logError } from "../log";
import { applyPush, type PushResult, preparePush } from "../push";
import { openTarget } from "../targets";
import type { RemoteTask, Target } from "../targets/types";
import { type AppContext, appContext, commandAi, resolveDate } from "./context";

export interface PushOptions {
  dryRun?: boolean;
  yes?: boolean;
  /** commander sets this to false for --no-ai */
  ai?: boolean;
}

const MARK: Record<string, string> = {
  create: "+",
  update: "~",
  delete: "-",
  same: "=",
  unmapped: "?",
  blocked: "!",
  theirs: "·",
};

export function planText(plan: PushPlan): string {
  return plan.items.map((i) => `  ${MARK[i.action]} ${describeItem(i)}`).join("\n");
}

/** `clockout push [date]`: send the reviewed day to the ERP, after showing what would change. */
export async function runPush(
  dateInput: string | undefined,
  opts: PushOptions,
  app?: AppContext,
  deps: { target?: Target; interactive?: boolean } = {},
) {
  const ctx = app ?? (await appContext());
  let config = ctx.config;
  if (!config.timesheet) {
    throw new Error(
      'No timesheet system is set up. Add a [timesheet] section to config.toml: type = "http" (see docs/timesheet-api.md) or type = "command".',
    );
  }
  const target = deps.target ?? (await openTarget(config));
  if (!target) return;
  const interactive = deps.interactive ?? (process.stdin.isTTY && process.stdout.isTTY);
  const date = resolveDate(dateInput, config.me.timezone);

  const ai = await commandAi(config, opts.ai);
  const { stored, warnings } = await openDay(date, config, ctx.store, { ai, log: logError });
  for (const w of warnings) console.error(`warning: ${w}`);
  const meetings = stored.day.questions.filter((q) => q.blockId).length;
  if (meetings) {
    console.error(
      `${meetings} meeting${meetings === 1 ? "" : "s"} waiting for an answer aren't sent. Run \`clockout\` to review.`,
    );
  }

  let plan = await preparePush(stored, config, target);
  const unmapped = plan.items.flatMap((i) => (i.action === "unmapped" ? [i.row] : []));
  if (unmapped.length && interactive && !opts.yes && !opts.dryRun) {
    config = await pickTasks(unmapped, config, target);
    plan = await preparePush(stored, config, target);
  }

  const where = config.timesheet ? targetWhere(config.timesheet) : "";
  console.log(`${date} → ${where}\n${planText(plan) || "  (nothing to send)"}`);
  if (plan.items.some((i) => i.action === "unmapped")) {
    console.error(
      "\nRows marked ? need an ERP task: pick them in the review screen (ctrl+s) or run `clockout push` in a terminal.",
    );
  }
  const todo = changes(plan);
  if (opts.dryRun) return;
  // So a script can tell something was left out (no task yet, approved, a closed week), even
  // when there's nothing else to send.
  if (plan.items.some((i) => i.action === "unmapped" || i.action === "blocked"))
    process.exitCode = 1;
  if (todo.length === 0) {
    console.log("\nNothing to send.");
    return;
  }
  if (!opts.yes) {
    if (!interactive) throw new Error("Add --yes to send without being asked.");
    const ok = await confirm({
      message: `Send ${todo.length} change${todo.length === 1 ? "" : "s"}?`,
    });
    if (isCancel(ok) || !ok) {
      console.log("Nothing sent.");
      return;
    }
  }
  const result = await applyPush(stored, plan, target, ctx.store);
  report(result);
}

function report({ done, failed, unconfirmed }: PushResult) {
  console.log(`\nSent ${done} change${done === 1 ? "" : "s"}.`);
  for (const f of failed) console.error(`  ✗ ${describeItem(f.item)}\n    ${f.error}`);
  if (unconfirmed)
    console.error(
      `Couldn't check what the ERP now has (${unconfirmed}). Run the same push again to check; nothing is sent twice.`,
    );
  if (failed.length || unconfirmed) process.exitCode = 1;
}

/** Asks which ERP task each unmapped project goes to and saves the answers in config. */
async function pickTasks(rows: PushRow[], config: Config, target: Target): Promise<Config> {
  const { configFile } = resolvePaths();
  let next = config;
  const projects = [...new Set(rows.map((r) => r.project))];
  const recent = await target.searchTasks("").catch(() => [] as RemoteTask[]);
  for (const project of projects) {
    const name = project.split("/").pop() ?? project;
    const matches = await target.searchTasks(name).catch(() => [] as RemoteTask[]);
    const tasks = [...new Map([...matches, ...recent].map((t) => [t.id, t])).values()];
    const choice = await autocomplete({
      message: `Which ERP task is ${project}? (type to filter)`,
      options: tasks.map((t) => ({ value: t.id, label: t.subject, hint: t.project })),
      placeholder: name,
    });
    if (isCancel(choice)) break;
    const task = tasks.find((t) => t.id === choice);
    next = withTaskMapping(next, {
      project,
      erp_task: String(choice),
      ...(task ? { label: task.subject } : {}),
    });
  }
  if (next !== config) {
    await saveConfig(configFile, next);
    next = (await loadConfig(configFile)) ?? next;
  }
  return next;
}
