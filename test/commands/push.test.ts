import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runPush } from "../../src/commands/push";
import { DayStore } from "../../src/store/json-store";
import { stored } from "../helpers/fake-app";
import { fakeTarget } from "../helpers/fake-target";
import { FIXTURE_DATE, fixtureConfig } from "../helpers/fixture-day";

const config = fixtureConfig({
  sources: [],
  timesheet: {
    type: "next-pms",
    url: "https://erp.example.com",
    map: [{ project: "acme/api", erp_task: "TASK-DEV", label: "API maintenance" }],
  },
});

let out: string[];
let err: string[];
beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, "log").mockImplementation((...a) => void out.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a) => void err.push(a.join(" ")));
});
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
});

async function app() {
  const store = new DayStore(await mkdtemp(join(tmpdir(), "clockout-push-cmd-")));
  // Corrected, so the fixture day is shown as saved instead of rebuilt from (no) sources.
  await store.save({ ...stored, edits: [{ at: "", ops: [{ op: "clarify", question: "-" }] }] });
  return { config, store };
}

describe("clockout push", () => {
  it("shows the plan and sends nothing with --dry-run", async () => {
    const erp = fakeTarget();
    await runPush(FIXTURE_DATE, { dryRun: true, ai: false }, await app(), {
      target: erp.target,
      interactive: false,
    });
    const text = out.join("\n");
    expect(text).toContain(`${FIXTURE_DATE} → https://erp.example.com`);
    expect(text).toMatch(/\+ Add \dh\d\d to API maintenance: /);
    expect(text).toContain("? Needs an ERP task: dev-example/clockout");
    expect(erp.calls).toEqual([]);
  });

  it("won't send without being asked when it can't ask", async () => {
    await expect(
      runPush(FIXTURE_DATE, { ai: false }, await app(), {
        target: fakeTarget().target,
        interactive: false,
      }),
    ).rejects.toThrow("--yes");
  });

  it("sends the mapped rows with --yes and reports refusals", async () => {
    const erp = fakeTarget({ fail: () => "Future time entries are not allowed." });
    await runPush(FIXTURE_DATE, { yes: true, ai: false }, await app(), {
      target: erp.target,
      interactive: false,
    });
    expect(erp.calls[0]).toMatch(/^create TASK-DEV /);
    expect(err.join("\n")).toContain("Future time entries are not allowed.");
    expect(process.exitCode).toBe(1);
  });

  it("explains how to connect when no ERP is set up", async () => {
    await expect(
      runPush(FIXTURE_DATE, {}, { config: fixtureConfig(), store: (await app()).store }),
    ).rejects.toThrow("clockout connect erp");
  });
});
