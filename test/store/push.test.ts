import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDay } from "../../src/collect";
import type { Config } from "../../src/config/schema";
import { changes } from "../../src/core/push";
import { timesheetRows } from "../../src/core/timesheet";
import { applyPush, preparePush } from "../../src/push";
import { DayStore, type StoredDay } from "../../src/store/json-store";
import { fixtureDay, stored as fixtureStored } from "../helpers/fake-app";
import { fakeTarget } from "../helpers/fake-target";
import { FIXTURE_DATE, fixtureConfig } from "../helpers/fixture-day";

/** Every project on the fixture day goes to one ERP task, meetings to another. */
function withErp(config: Config): Config {
  const projects = [...new Set(timesheetRows(fixtureDay, config).map((r) => r.project))];
  return {
    ...config,
    timesheet: {
      type: "next-pms",
      url: "https://erp.example.com",
      map: projects.map((project) => ({
        project,
        erp_task: project === "Meetings" ? "TASK-MEET" : "TASK-DEV",
      })),
    },
  };
}

const config = withErp(fixtureConfig());
const rowCount = timesheetRows(fixtureDay, config).length;

async function setup() {
  const store = new DayStore(await mkdtemp(join(tmpdir(), "clockout-push-")));
  await store.save(fixtureStored);
  return store;
}

describe("sending a day", () => {
  it("sends every row once; sending again changes nothing", async () => {
    const store = await setup();
    const erp = fakeTarget();
    const plan = await preparePush(fixtureStored, config, erp.target);
    expect(changes(plan)).toHaveLength(rowCount);

    const first = await applyPush(fixtureStored, plan, erp.target, store);
    expect(first.done).toBe(rowCount);
    expect(first.failed).toEqual([]);
    expect(first.stored.pushed).toHaveLength(rowCount);
    expect((await store.load(FIXTURE_DATE))?.pushed).toEqual(first.stored.pushed);

    const again = await preparePush(first.stored, config, erp.target);
    expect(changes(again)).toEqual([]);
    expect(again.items.every((i) => i.action === "same")).toBe(true);
    expect(erp.entries).toHaveLength(rowCount);
  });

  it("says when it couldn't read back what it sent, and sending again adds nothing twice", async () => {
    const store = await setup();
    const erp = fakeTarget();
    const plan = await preparePush(fixtureStored, config, erp.target);
    const down = { ...erp.target, day: () => Promise.reject(new Error("Couldn't reach the ERP.")) };
    const r = await applyPush(fixtureStored, plan, down, store);
    expect(r.done).toBe(rowCount);
    expect(r.unconfirmed).toBe("Couldn't reach the ERP.");
    expect(r.stored).toBe(fixtureStored);

    const again = await preparePush(r.stored, config, erp.target);
    expect(changes(again)).toEqual([]);
  });

  it("won't send a day that adds up to more than 24 hours", async () => {
    const [first, ...rest] = fixtureStored.day.blocks;
    const long = {
      ...fixtureStored,
      day: { ...fixtureStored.day, blocks: [{ ...first, minutes: 24 * 60 } as never, ...rest] },
    };
    await expect(preparePush(long, config, fakeTarget().target)).rejects.toThrow(
      /more than a day has/,
    );
  });

  it("keeps going after a refused entry and sends it next time", async () => {
    const store = await setup();
    let refuse = true;
    const erp = fakeTarget({
      fail: (what, e) =>
        refuse && what === "create" && e?.task === "TASK-MEET"
          ? "Hour should be greater than 0."
          : undefined,
    });
    const first = await applyPush(
      fixtureStored,
      await preparePush(fixtureStored, config, erp.target),
      erp.target,
      store,
    );
    expect(first.failed.map((f) => f.error)).toContain("Hour should be greater than 0.");
    expect(first.done).toBe(rowCount - first.failed.length);

    refuse = false;
    const retry = await preparePush(first.stored, config, erp.target);
    expect(changes(retry).map((i) => i.action)).toEqual(first.failed.map(() => "create"));
  });

  it("updates what it sent after you correct the day", async () => {
    const store = await setup();
    const erp = fakeTarget();
    const sent = await applyPush(
      fixtureStored,
      await preparePush(fixtureStored, config, erp.target),
      erp.target,
      store,
    );
    const first = sent.stored.day.blocks.find(
      (b) => b.kind === "work",
    ) as (typeof sent.stored.day.blocks)[0];
    const corrected: StoredDay = {
      ...sent.stored,
      day: {
        ...sent.stored.day,
        blocks: sent.stored.day.blocks.map((b) => (b.id === first.id ? { ...b, minutes: 300 } : b)),
      },
    };
    const plan = await preparePush(corrected, config, erp.target);
    expect(changes(plan).map((i) => i.action)).toEqual(["update"]);
    await applyPush(corrected, plan, erp.target, store);
    expect(erp.calls.at(-1)).toMatch(/^update new-\d+ 5$/);
  });

  it("remembers what was sent when the day is rebuilt", async () => {
    const store = await setup();
    const pushed = [{ key: "k", id: "e1", parent: "TS-1", task: "TASK-DEV" }];
    await store.save({ ...fixtureStored, pushed, pushedAt: "2026-10-16T18:00:00Z" });
    // No sources run: nothing reaches GitHub or the calendar's address.
    const { stored } = await openDay(FIXTURE_DATE, config, store, {
      ctx: { homeDir: "/nonexistent", env: {} },
      refresh: true,
      sources: () => undefined,
    });
    expect(stored.pushed).toEqual(pushed);
    expect(stored.pushedAt).toBe("2026-10-16T18:00:00Z");
  });
});
