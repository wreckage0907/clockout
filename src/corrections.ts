import type { Config } from "./config/schema";
import { applyEdits, type EditResult } from "./core/edits";
import type { EditOp } from "./core/types";
import type { DayStore, StoredDay } from "./store/json-store";

/** Applies edits to a stored day and saves it with an undo point. Nothing is saved on errors. */
export async function commitEdits(
  stored: StoredDay,
  ops: EditOp[],
  config: Config,
  store: DayStore,
  text?: string,
): Promise<EditResult & { stored: StoredDay }> {
  const result = applyEdits(stored.day, ops, config);
  const changes = ops.filter((o) => o.op !== "clarify");
  if (result.errors.length || changes.length === 0) return { ...result, stored };
  const next: StoredDay = {
    ...stored,
    day: result.day,
    history: [...stored.history, stored.day],
    edits: [
      ...stored.edits,
      { at: new Date().toISOString(), ...(text ? { text } : {}), ops: changes },
    ],
  };
  await store.save(next);
  return { ...result, stored: next };
}

/** Restores the previous version of the day. Returns null when there's nothing to undo. */
export async function undoEdit(stored: StoredDay, store: DayStore): Promise<StoredDay | null> {
  const previous = stored.history.at(-1);
  if (!previous) return null;
  const next: StoredDay = {
    ...stored,
    day: previous,
    history: stored.history.slice(0, -1),
    edits: stored.edits.slice(0, -1),
  };
  await store.save(next);
  return next;
}
