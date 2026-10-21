import type { TaskMapping } from "../config/schema";
import { formatDuration } from "./time";
import { rowKey } from "./timesheet";
import type { TimesheetRow } from "./types";

// Sending a day to a timesheet system: compare the rows with what's already there and with what
// Clockout sent before, and say what would change. Pure; src/push.ts does the IO.

/** An entry already in the timesheet system for the day. */
export interface RemoteEntry {
  /** The entry's id there. */
  id: string;
  /** The document it lives in (a Timesheet in next-pms). */
  parent: string;
  task: string;
  hours: number;
  /** Plain text. */
  description: string;
  /** Why it can't be changed (approved, rejected…), when it can't. */
  locked?: string;
}

/** The entries for a day, and why nothing new can be added, if it can't. */
export interface RemoteDay {
  entries: RemoteEntry[];
  /** e.g. "This week is already approved." */
  closed?: string;
}

/** What Clockout sent for a row last time, kept with the day. */
export interface PushedEntry {
  /** The row's key (see `rowKey`). */
  key: string;
  id: string;
  parent: string;
  task: string;
}

/** A row with the key it's tracked by. */
export interface PushRow extends TimesheetRow {
  key: string;
}

/** The entry a row should become. */
export interface Desired {
  task: string;
  /** The task's name in the timesheet system, for display. */
  label: string;
  hours: number;
  description: string;
}

export type PushItem =
  | { action: "create"; row: PushRow; want: Desired }
  | { action: "update"; row: PushRow; want: Desired; remote: RemoteEntry }
  | { action: "same"; row: PushRow; want: Desired; remote: RemoteEntry }
  | { action: "delete"; remote: RemoteEntry; key: string; label: string }
  /** No ERP task for this row yet. */
  | { action: "unmapped"; row: PushRow }
  | { action: "blocked"; row?: PushRow; remote?: RemoteEntry; reason: string }
  /** In the timesheet system but not from Clockout (added there by hand); left alone. */
  | { action: "theirs"; remote: RemoteEntry; label: string };

export interface PushPlan {
  date: string;
  items: PushItem[];
}

export function pushRows(rows: readonly TimesheetRow[]): PushRow[] {
  return rows.map((r) => ({
    ...r,
    key: rowKey({ project: r.project, task: r.task, summary: r.description }),
  }));
}

/** The mapping for a row: one for its project and task, else one for the whole project. */
export function mappingFor(
  row: Pick<TimesheetRow, "project" | "task">,
  map: readonly TaskMapping[],
): TaskMapping | undefined {
  return (
    map.find((m) => m.project === row.project && m.task === row.task) ??
    map.find((m) => m.project === row.project && m.task === undefined)
  );
}

/** Hours as the timesheet system stores them. */
export function roundHours(h: number): number {
  return Math.round(h * 100) / 100;
}

/** Text as stored: rich-text editors save HTML, compare it as plain text. */
export function plainText(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

function same(want: Desired, r: RemoteEntry): boolean {
  return (
    r.task === want.task &&
    Math.abs(r.hours - want.hours) < 0.005 &&
    plainText(r.description) === plainText(want.description)
  );
}

/**
 * What sending `rows` would do. Each row finds its entry by, in order: the entry sent for that
 * row before; an entry sent before on the same ERP task whose row is gone (the description
 * changed); an untracked entry with the same task and description (sent before the record was
 * saved). Anything sent before that no row claims is deleted. Entries Clockout didn't send
 * are never touched.
 */
export function planPush(
  date: string,
  rows: readonly PushRow[],
  map: readonly TaskMapping[],
  remote: RemoteDay,
  pushed: readonly PushedEntry[],
): PushPlan {
  const byId = new Map(remote.entries.map((e) => [e.id, e]));
  const labelOf = (task: string) => map.find((m) => m.erp_task === task)?.label ?? task;
  // Sent before and still there.
  const ledger = pushed.filter((p) => byId.has(p.id));
  const claimed = new Set<string>();
  const items: PushItem[] = [];

  const wants = rows.map((row) => {
    const m = mappingFor(row, map);
    const want: Desired | null = m
      ? {
          task: m.erp_task,
          label: m.label ?? m.erp_task,
          hours: roundHours(row.hours),
          description: row.description,
        }
      : null;
    return { row, want };
  });

  // 1. The entry sent for this very row. A row that lost its mapping keeps its entry as it is:
  // where it should go is unknown, not "nowhere".
  const found = new Map<PushRow, RemoteEntry>();
  for (const { row, want } of wants) {
    const p = ledger.find((l) => l.key === row.key && !claimed.has(l.id));
    if (!p) continue;
    claimed.add(p.id);
    if (want) found.set(row, byId.get(p.id) as RemoteEntry);
  }
  // 2. One sent before on the same task whose row no longer exists.
  for (const { row, want } of wants) {
    if (!want || found.has(row)) continue;
    const p = ledger.find((l) => l.task === want.task && !claimed.has(l.id));
    if (p) {
      found.set(row, byId.get(p.id) as RemoteEntry);
      claimed.add(p.id);
    }
  }
  // 3. An untracked entry that is exactly this row (sent, but the record wasn't saved).
  const tracked = new Set(ledger.map((l) => l.id));
  for (const { row, want } of wants) {
    if (!want || found.has(row)) continue;
    const e = remote.entries.find(
      (r) =>
        !tracked.has(r.id) &&
        !claimed.has(r.id) &&
        r.task === want.task &&
        plainText(r.description) === plainText(want.description),
    );
    if (e) {
      found.set(row, e);
      claimed.add(e.id);
    }
  }

  for (const { row, want } of wants) {
    if (!want) {
      items.push({ action: "unmapped", row });
      continue;
    }
    const remoteEntry = found.get(row);
    if (want.hours <= 0) {
      // A row you set to zero isn't sent; one sent before is taken back out.
      if (remoteEntry?.locked)
        items.push({ action: "blocked", row, remote: remoteEntry, reason: remoteEntry.locked });
      else if (remoteEntry)
        items.push({ action: "delete", remote: remoteEntry, key: row.key, label: want.label });
      continue;
    }
    if (!remoteEntry) {
      if (remote.closed) items.push({ action: "blocked", row, reason: remote.closed });
      else items.push({ action: "create", row, want });
    } else if (same(want, remoteEntry)) {
      items.push({ action: "same", row, want, remote: remoteEntry });
    } else if (remoteEntry.locked) {
      items.push({ action: "blocked", row, remote: remoteEntry, reason: remoteEntry.locked });
    } else {
      items.push({ action: "update", row, want, remote: remoteEntry });
    }
  }

  for (const p of ledger) {
    if (claimed.has(p.id)) continue;
    const e = byId.get(p.id) as RemoteEntry;
    if (e.locked) items.push({ action: "blocked", remote: e, reason: e.locked });
    else items.push({ action: "delete", remote: e, key: p.key, label: labelOf(e.task) });
    claimed.add(p.id);
  }
  for (const e of remote.entries) {
    if (!claimed.has(e.id) && !tracked.has(e.id))
      items.push({ action: "theirs", remote: e, label: labelOf(e.task) });
  }
  return { date, items };
}

/** Items that write something. */
export function changes(plan: PushPlan): PushItem[] {
  return plan.items.filter(
    (i) => i.action === "create" || i.action === "update" || i.action === "delete",
  );
}

/**
 * The record to keep after sending: each row that was sent (or already matched) and the entry
 * it is now. `after` is the day re-read from the timesheet system; entries are matched by task,
 * hours and description, because a create doesn't say what id it made.
 */
export function ledgerAfter(
  plan: PushPlan,
  done: ReadonlySet<PushItem>,
  after: RemoteDay,
  before: readonly PushedEntry[],
): PushedEntry[] {
  const out: PushedEntry[] = [];
  const used = new Set<string>();
  const take = (key: string, e: RemoteEntry) => {
    out.push({ key, id: e.id, parent: e.parent, task: e.task });
    used.add(e.id);
  };
  const match = (want: Desired, prefer?: string) => {
    const fits = (e: RemoteEntry) => !used.has(e.id) && same(want, e);
    return (
      after.entries.find((e) => e.id === prefer && fits(e)) ??
      after.entries.find((e) => fits(e) && !before.some((b) => b.id === e.id && b.id !== prefer))
    );
  };
  for (const item of plan.items) {
    if (item.action === "unmapped") {
      // Its entry stays as it was; keep knowing it's ours.
      const prev = before.find((b) => b.key === item.row.key);
      const e = after.entries.find((x) => x.id === prev?.id);
      if (prev && e && !used.has(e.id)) {
        out.push({ ...prev, parent: e.parent });
        used.add(e.id);
      }
    } else if (item.action === "same") {
      const e = after.entries.find((x) => x.id === item.remote.id) ?? match(item.want);
      if (e) take(item.row.key, e);
    } else if ((item.action === "create" || item.action === "update") && done.has(item)) {
      const e = match(item.want, item.action === "update" ? item.remote.id : undefined);
      if (e) take(item.row.key, e);
    } else if (
      (item.action === "update" || item.action === "delete" || item.action === "blocked") &&
      !done.has(item)
    ) {
      // Not changed this time: keep tracking the entry while it's still there.
      const id = item.remote?.id;
      const prev = before.find((b) => b.id === id);
      const e = after.entries.find((x) => x.id === id);
      if (prev && e && !used.has(e.id)) {
        out.push({ ...prev, parent: e.parent });
        used.add(e.id);
      }
    }
  }
  return out;
}

const hours = (h: number) => formatDuration(h * 60);

/** One line per item, for the CLI and the review screen. */
export function describeItem(i: PushItem): string {
  switch (i.action) {
    case "create":
      return `Add ${hours(i.want.hours)} to ${i.want.label}: ${i.want.description}`;
    case "update": {
      const what = [
        i.remote.task !== i.want.task ? `task → ${i.want.label}` : "",
        Math.abs(i.remote.hours - i.want.hours) >= 0.005
          ? `${hours(i.remote.hours)} → ${hours(i.want.hours)}`
          : "",
        plainText(i.remote.description) !== plainText(i.want.description) ? "new description" : "",
      ].filter(Boolean);
      return `Update ${i.want.label} (${what.join(", ")}): ${i.want.description}`;
    }
    case "same":
      return `Already sent: ${hours(i.want.hours)} on ${i.want.label}: ${i.want.description}`;
    case "delete":
      return `Remove ${hours(i.remote.hours)} on ${i.label}: ${i.remote.description}`;
    case "unmapped":
      return `Needs an ERP task: ${i.row.project} · ${i.row.task}: ${i.row.description}`;
    case "blocked":
      return `Can't send: ${i.reason} (${i.row?.description ?? i.remote?.description ?? ""})`;
    case "theirs":
      return `In the ERP already, not from Clockout: ${hours(i.remote.hours)} on ${i.label}: ${i.remote.description}`;
  }
}
