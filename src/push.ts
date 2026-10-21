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
  const remote = await target.day(stored.date);
  return planPush(
    stored.date,
    pushRows(timesheetRows(stored.day, config)),
    config.timesheet?.map ?? [],
    remote,
    stored.pushed ?? [],
  );
}

export interface PushResult {
  stored: StoredDay;
  /** Items written. */
  done: number;
  /** Items that failed, with the timesheet system's reason. */
  failed: { item: PushItem; error: string }[];
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
  const after = await target.day(plan.date);
  const next: StoredDay = {
    ...stored,
    pushed: ledgerAfter(plan, done, after, stored.pushed ?? []),
    pushedAt: new Date().toISOString(),
  };
  await store.save(next);
  return { stored: next, done: done.size, failed };
}
