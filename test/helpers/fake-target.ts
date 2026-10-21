import type { RemoteEntry } from "../../src/core/push";
import type { EntryInput, RemoteTask, Target } from "../../src/targets/types";

/**
 * A timesheet system in memory that behaves like next-pms: a create doesn't say what id it made,
 * and `fail` makes chosen writes throw like a validation error.
 */
export function fakeTarget(
  opts: {
    entries?: (RemoteEntry & { date: string })[];
    tasks?: RemoteTask[];
    fail?: (what: "create" | "update" | "remove", e?: EntryInput) => string | undefined;
  } = {},
) {
  const entries = [...(opts.entries ?? [])];
  const calls: string[] = [];
  let n = 0;
  const failIf = (what: "create" | "update" | "remove", e?: EntryInput) => {
    const reason = opts.fail?.(what, e);
    if (reason) throw new Error(reason);
  };
  const target: Target = {
    id: "fake",
    name: "the ERP",
    async day(date) {
      return {
        entries: entries.filter((e) => e.date === date).map(({ date: _, ...e }) => ({ ...e })),
      };
    },
    async searchTasks(query) {
      const q = query.toLowerCase();
      return (opts.tasks ?? []).filter((t) => t.subject.toLowerCase().includes(q));
    },
    async create(date, e) {
      calls.push(`create ${e.task} ${e.hours}`);
      failIf("create", e);
      entries.push({ date, id: `new-${++n}`, parent: `TS-${date}`, ...e });
    },
    async update(_date, id, _parent, e) {
      calls.push(`update ${id} ${e.hours}`);
      failIf("update", e);
      const i = entries.findIndex((x) => x.id === id);
      const old = entries[i];
      if (old) entries[i] = { ...old, ...e };
    },
    async remove(id) {
      calls.push(`remove ${id}`);
      failIf("remove");
      const i = entries.findIndex((x) => x.id === id);
      if (i >= 0) entries.splice(i, 1);
    },
  };
  return { target, entries, calls };
}
