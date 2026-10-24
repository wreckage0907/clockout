import type { Config } from "./config/schema";
import {
  changes,
  ledgerAfter,
  type PushItem,
  type PushPlan,
  planPush,
  pushRows,
} from "./core/push";
import { timesheetRows } from "./core/timesheet";
import type { DayStore, StoredDay } from "./store/json-store";
import type { Target } from "./targets/types";

/** What sending the day would do: reads the day from the timesheet system, writes nothing. */
export async function preparePush(
  stored: StoredDay,
  config: Config,
  target: Target,
): Promise<PushPlan> {
  const rows = pushRows(timesheetRows(stored.day, config));
  const total = rows.reduce((sum, r) => sum + r.hours, 0);
  if (total > 24)
    throw new Error(
      `${stored.date} adds up to ${total.toFixed(2)}h, more than a day has. Fix the hours before sending.`,
    );
  const remote = await target.day(stored.date);
  return planPush(stored.date, rows, config.timesheet?.map ?? [], remote, stored.pushed ?? []);
}

export interface PushResult {
  stored: StoredDay;
  /** Items written. */
  done: number;
  /** Items that failed, with the timesheet system's reason. */
  failed: { item: PushItem; error: string }[];
  /** Why what was sent couldn't be read back (the record of it is then left as it was). */
  unconfirmed?: string;
}

/**
 * Writes the plan's changes one by one (a failure doesn't stop the rest), then re-reads the day
 * and saves which entry each row now is, so the next send updates instead of adding again.
 */
export async function applyPush(
  stored: StoredDay,
  plan: PushPlan,
  target: Target,
  store: DayStore,
): Promise<PushResult> {
  const done = new Set<PushItem>();
  const failed: PushResult["failed"] = [];
  // Deletes first, so a day near a limit has room for what replaces them.
  const order = { delete: 0, update: 1, create: 2 } as Record<string, number>;
  const todo = changes(plan).sort((a, b) => (order[a.action] ?? 3) - (order[b.action] ?? 3));
  for (const item of todo) {
    try {
      if (item.action === "delete") await target.remove(item.remote.id, item.remote.parent);
      else if (item.action === "update")
        await target.update(plan.date, item.remote.id, item.remote.parent, item.want);
      else if (item.action === "create") await target.create(plan.date, item.want);
      done.add(item);
    } catch (err) {
      failed.push({ item, error: (err as Error).message });
    }
  }
  let after: Awaited<ReturnType<Target["day"]>>;
  try {
    after = await target.day(plan.date);
  } catch (err) {
    // Sending again matches what's already there, so nothing is added twice.
    return { stored, done: done.size, failed, unconfirmed: (err as Error).message };
  }
  const next: StoredDay = {
    ...stored,
    pushed: ledgerAfter(plan, done, after, stored.pushed ?? []),
    pushedAt: new Date().toISOString(),
  };
  await store.save(next);
  return { stored: next, done: done.size, failed };
}
