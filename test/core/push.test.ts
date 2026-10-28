import { describe, expect, it } from "vitest";
import type { TaskMapping } from "../../src/config/schema";
import {
  changes,
  describeItem,
  ledgerAfter,
  mappingFor,
  type PushedEntry,
  type PushItem,
  plainText,
  planPush,
  pushRows,
  type RemoteDay,
  type RemoteEntry,
} from "../../src/core/push";

const DATE = "2026-10-16";
const map: TaskMapping[] = [
  { project: "acme/api", erp_task: "TASK-1", label: "API maintenance" },
  { project: "Meetings", erp_task: "TASK-2", label: "Internal meetings" },
];

const rows = pushRows([
  {
    date: DATE,
    project: "acme/api",
    task: "Development",
    hours: 2.25,
    description: "Fix auth refresh",
  },
  { date: DATE, project: "Meetings", task: "Meetings", hours: 0.25, description: "Daily standup" },
]);
const [auth, standup] = rows as [(typeof rows)[0], (typeof rows)[0]];

const entry = (e: Partial<RemoteEntry> & { id: string }): RemoteEntry => ({
  parent: "TS-1",
  task: "TASK-1",
  hours: 2.25,
  description: "Fix auth refresh",
  ...e,
});
const remote = (...entries: RemoteEntry[]): RemoteDay => ({ entries });
const actions = (items: PushItem[]) => items.map((i) => i.action);

describe("planPush", () => {
  it("adds every mapped row when nothing was sent yet", () => {
    const plan = planPush(DATE, rows, map, remote(), []);
    expect(actions(plan.items)).toEqual(["create", "create"]);
    expect(plan.items[0]).toMatchObject({
      want: {
        task: "TASK-1",
        label: "API maintenance",
        hours: 2.25,
        description: "Fix auth refresh",
      },
    });
  });

  it("leaves entries it sent alone when nothing changed", () => {
    const sent = entry({ id: "e1" });
    const plan = planPush(DATE, [auth], map, remote(sent), [
      { key: auth.key, id: "e1", parent: "TS-1", task: "TASK-1" },
    ]);
    expect(actions(plan.items)).toEqual(["same"]);
    expect(changes(plan)).toEqual([]);
  });

  it("updates the entry it sent when the hours change", () => {
    const plan = planPush(DATE, [auth], map, remote(entry({ id: "e1", hours: 1 })), [
      { key: auth.key, id: "e1", parent: "TS-1", task: "TASK-1" },
    ]);
    expect(plan.items[0]).toMatchObject({ action: "update", remote: { id: "e1" } });
    expect(describeItem(plan.items[0] as PushItem)).toContain("1h00 → 2h15");
  });

  it("describes an item on one clean line even when the server's words are hostile", () => {
    const hostile = "Old\u001b]52;c;ZXZpbA==\u0007\u001b[2J\nwords‮";
    const plan = planPush(DATE, [auth], map, remote(entry({ id: "e9", description: hostile })), []);
    const theirs = plan.items.find((i) => i.action === "theirs") as PushItem;
    const line = describeItem(theirs);
    expect(line).toContain("Old words");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: that's what the test is about
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f‮]/);
  });

  it("updates, not duplicates, when the description changed (the row's key changed)", () => {
    const ledger: PushedEntry[] = [{ key: "old-key", id: "e1", parent: "TS-1", task: "TASK-1" }];
    const sent = entry({ id: "e1", description: "Old words" });
    const plan = planPush(DATE, [auth], map, remote(sent), ledger);
    expect(plan.items).toMatchObject([{ action: "update", remote: { id: "e1" } }]);
  });

  it("adopts an untracked entry that is exactly the row, so a lost record never duplicates", () => {
    const plan = planPush(
      DATE,
      [auth],
      map,
      remote(entry({ id: "e9", description: "<p>Fix auth refresh</p>" })),
      [],
    );
    expect(actions(plan.items)).toEqual(["same"]);
  });

  it("removes what it sent for a row that's gone, and never touches entries added by hand", () => {
    const mine = entry({ id: "e1" });
    const theirs = entry({ id: "h1", description: "Pairing, logged in the ERP" });
    const plan = planPush(DATE, [], map, remote(mine, theirs), [
      { key: auth.key, id: "e1", parent: "TS-1", task: "TASK-1" },
    ]);
    expect(plan.items).toMatchObject([
      { action: "delete", remote: { id: "e1" }, label: "API maintenance" },
      { action: "theirs", remote: { id: "h1" } },
    ]);
  });

  it("takes an entry back out when its row is set to zero", () => {
    const zero = pushRows([{ ...auth, hours: 0 }]);
    const plan = planPush(DATE, zero, map, remote(entry({ id: "e1" })), [
      { key: (zero[0] as (typeof zero)[0]).key, id: "e1", parent: "TS-1", task: "TASK-1" },
    ]);
    expect(actions(plan.items)).toEqual(["delete"]);
    expect(actions(planPush(DATE, zero, map, remote(), []).items)).toEqual([]);
  });

  it("asks for a task for rows with no mapping", () => {
    const plan = planPush(DATE, rows, [map[0] as TaskMapping], remote(), []);
    expect(plan.items).toMatchObject([
      { action: "create" },
      { action: "unmapped", row: { project: "Meetings" } },
    ]);
  });

  it("leaves an entry alone when its row loses its mapping", () => {
    const plan = planPush(DATE, [auth], [], remote(entry({ id: "e1" })), [
      { key: auth.key, id: "e1", parent: "TS-1", task: "TASK-1" },
    ]);
    expect(actions(plan.items)).toEqual(["unmapped"]);
    const ledger = [{ key: auth.key, id: "e1", parent: "TS-1", task: "TASK-1" }];
    expect(ledgerAfter(plan, new Set(), remote(entry({ id: "e1" })), ledger)).toEqual(ledger);
  });

  it("won't change approved or rejected entries, or add to a closed week", () => {
    const locked = entry({ id: "e1", hours: 1, locked: "Already approved in the ERP." });
    const ledger = [{ key: auth.key, id: "e1", parent: "TS-1", task: "TASK-1" }];
    expect(planPush(DATE, [auth], map, remote(locked), ledger).items).toMatchObject([
      { action: "blocked", reason: "Already approved in the ERP." },
    ]);
    expect(planPush(DATE, [], map, remote(locked), ledger).items).toMatchObject([
      { action: "blocked" },
    ]);
    const closed = { entries: [], closed: "This week is already approved in the ERP." };
    expect(planPush(DATE, [auth], map, closed, []).items).toMatchObject([
      { action: "blocked", reason: closed.closed },
    ]);
  });

  it("forgets entries that were deleted in the ERP and sends the row again", () => {
    const plan = planPush(DATE, [auth], map, remote(), [
      { key: auth.key, id: "gone", parent: "TS-1", task: "TASK-1" },
    ]);
    expect(actions(plan.items)).toEqual(["create"]);
  });
});

describe("mappingFor", () => {
  it("prefers a mapping for the project and task over one for the whole project", () => {
    const m: TaskMapping[] = [
      { project: "acme/api", erp_task: "ALL" },
      { project: "acme/api", task: "Code Review", erp_task: "REVIEW" },
    ];
    expect(mappingFor({ project: "acme/api", task: "Code Review" }, m)?.erp_task).toBe("REVIEW");
    expect(mappingFor({ project: "acme/api", task: "Development" }, m)?.erp_task).toBe("ALL");
    expect(mappingFor({ project: "other", task: "Development" }, m)).toBeUndefined();
  });
});

describe("ledgerAfter", () => {
  it("records the entry each sent row became, found by task, hours and description", () => {
    const plan = planPush(DATE, rows, map, remote(), []);
    const after = remote(
      entry({ id: "n1" }),
      entry({ id: "n2", task: "TASK-2", hours: 0.25, description: "Daily standup" }),
    );
    const done = new Set(plan.items);
    expect(ledgerAfter(plan, done, after, [])).toEqual([
      { key: auth.key, id: "n1", parent: "TS-1", task: "TASK-1" },
      { key: standup.key, id: "n2", parent: "TS-1", task: "TASK-2" },
    ]);
  });

  it("keeps tracking entries whose change failed, and drops ones it couldn't create", () => {
    const ledger = [{ key: auth.key, id: "e1", parent: "TS-1", task: "TASK-1" }];
    const before = remote(entry({ id: "e1", hours: 1 }));
    const plan = planPush(DATE, rows, map, before, ledger);
    expect(ledgerAfter(plan, new Set(), before, ledger)).toEqual(ledger);
  });
});

describe("plainText", () => {
  it("reads rich-text descriptions as plain text", () => {
    expect(plainText("<p>Fix &amp; ship</p><p>Review&nbsp;PR</p>")).toBe("Fix & ship\nReview PR");
  });

  it("removes escape codes and invisible characters from what the server sent", () => {
    expect(plainText("Done\u001b]52;c;ZXZpbA==\u0007 \u001b[2Jfor‮you​")).toBe("Done foryou");
  });

  it("makes a rejected description comparable to the one sent", () => {
    expect(plainText("a​b")).toBe(plainText("ab"));
  });
});

describe("a row's own ERP task", () => {
  it("goes there instead of its project's task", () => {
    const own = pushRows([{ ...auth, sendTo: { task: "TASK-9", label: "Bug fixing" } }, standup]);
    const plan = planPush(DATE, own, map, remote(), []);
    expect(plan.items.map((i) => (i.action === "create" ? i.want.task : i.action))).toEqual([
      "TASK-9",
      "TASK-2",
    ]);
    expect(plan.items[0]).toMatchObject({ want: { label: "Bug fixing" } });
  });

  it("is sent even when the project has no task yet", () => {
    const own = pushRows([{ ...auth, project: "new/repo", sendTo: { task: "T", label: "T" } }]);
    expect(actions(planPush(DATE, own, [], remote(), []).items)).toEqual(["create"]);
  });
});
