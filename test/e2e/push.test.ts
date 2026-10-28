import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MockPms, startMockPms } from "../mock-pms/server";
import { DATE, fixtureSourcesToml, sandbox } from "./helpers";

// `clockout push` to a project-management system speaking Clockout's timesheet API: the mock
// PMS on 127.0.0.1 (test/mock-pms), with its own rules about tasks, hours and approvals.

/** The fixture day has three meetings nobody answered; push says they wait. */
const WAITING = "3 meetings waiting for an answer aren't sent. Run `clockout` to review.\n";

const MAP = {
  Meetings: "TASK-MEET",
  "acme/api": "TASK-API",
  "dev-example/clockout": "TASK-TOOLS",
};

async function setup(map: Record<string, string> = MAP) {
  const pms = await startMockPms();
  const sb = await sandbox();
  const rules = Object.entries(map)
    .map(([project, task]) => `[[timesheet.map]]\nproject = "${project}"\nerp_task = "${task}"`)
    .join("\n\n");
  await sb.writeConfig(
    await fixtureSourcesToml(sb, `\n[timesheet]\ntype = "http"\nurl = "${pms.url}"\n\n${rules}\n`),
  );
  const push = (args: string[] = ["--yes"], token = pms.token) =>
    sb.run(["push", DATE, "--no-ai", ...args], { env: { CLOCKOUT_TIMESHEET_TOKEN: token } });
  return { pms, push };
}

describe("sending a day to a PMS", () => {
  let pms: MockPms;
  let push: Awaited<ReturnType<typeof setup>>["push"];
  beforeAll(async () => {
    ({ pms, push } = await setup());
  });
  afterAll(() => pms.stop());

  it("shows what it would send and writes nothing on a dry run", async () => {
    const r = await push(["--dry-run"]);
    expect(r.stderr).toBe(WAITING);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe(`${DATE} → ${pms.url}`);
    expect(r.stdout).toContain("+ Add 2h00 to TASK-API: Fix auth token refresh");
    expect(pms.writes()).toEqual([]);
  });

  it("sends every row once, on the task its project maps to, with the token", async () => {
    const r = await push();
    expect(r.stderr).toBe(WAITING);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Sent 8 changes.");
    expect(pms.day(DATE).map((e) => [e.task, e.hours, e.description])).toEqual([
      ["TASK-MEET", 0.5, "Daily standup"],
      ["TASK-API", 2, "Fix auth token refresh"],
      ["TASK-API", 0.25, "Rate limit the login endpoint"],
      ["TASK-API", 0.5, "Fix rate limit"],
      ["TASK-API", 0.25, "Paginate the invoices endpoint"],
      ["TASK-TOOLS", 2.5, "Build export command"],
      ["TASK-API", 0.25, "Investigate flaky deploy"],
      ["TASK-TOOLS", 0.25, "Work on dev-example/clockout"],
    ]);
    expect(new Set(pms.requests.map((x) => x.auth))).toEqual(new Set(["Bearer mock-token"]));
  });

  it("sends nothing the second time", async () => {
    const before = pms.writes().length;
    const r = await push();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Nothing to send.");
    expect(pms.writes()).toHaveLength(before);
  });

  it("adds back an entry deleted in the PMS, and puts back one changed there", async () => {
    const [standup, auth] = pms.day(DATE);
    if (standup) pms.entries.splice(pms.entries.indexOf(standup), 1);
    if (auth) auth.hours = 5;
    const r = await push();
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Sent 2 changes.");
    expect(pms.day(DATE)).toHaveLength(8);
    expect(pms.day(DATE).find((e) => e.description === "Fix auth token refresh")?.hours).toBe(2);
  });

  it("leaves an approved entry alone, says why, and exits 1", async () => {
    const auth = pms.day(DATE).find((e) => e.description === "Fix auth token refresh");
    if (auth) auth.hours = 3;
    pms.lock(auth?.id ?? "");
    const before = pms.writes().length;
    const r = await push();
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(
      /\n {2}! Can't send: Approved by your manager\. \(Fix auth token refresh\)\n/,
    );
    expect(pms.writes()).toHaveLength(before);
    expect(auth?.hours).toBe(3);
  });

  it("says to check the token when the PMS refuses it, and when it's missing", async () => {
    const host = new URL(pms.url).host;
    const wrong = await push(["--yes"], "not-the-token");
    expect(wrong.code).toBe(1);
    expect(wrong.stdout).toBe("");
    expect(wrong.stderr).toContain(
      `clockout: ${host} refused the token in CLOCKOUT_TIMESHEET_TOKEN (Invalid token). Check it, or get a new one.\n`,
    );
    const missing = await push(["--yes"], "");
    expect(missing.stderr).toContain(
      `clockout: Set CLOCKOUT_TIMESHEET_TOKEN to your timesheet API's token (from ${host}) or put token = "…" under [timesheet] in config.toml, then try again.\n`,
    );
  });

  it("says when the PMS isn't answering", async () => {
    pms.setDown(true);
    const r = await push();
    pms.setDown(false);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      `clockout: ${new URL(pms.url).host} isn't answering right now (HTTP 503: Down for maintenance). Try again later.\n`,
    );
  });
});

describe("what the PMS refuses", () => {
  it("shows its reason for each row it refused, sends the rest, and exits 1", async () => {
    const { pms, push } = await setup({ ...MAP, "dev-example/clockout": "TASK-GONE" });
    const r = await push();
    await pms.stop();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("Sent 6 changes.");
    expect(r.stderr).toContain("    There's no task TASK-GONE.\n");
    expect(pms.day(DATE)).toHaveLength(6);
  });

  it("sends nothing to a week that's already approved", async () => {
    const { pms, push } = await setup();
    pms.closeDate(DATE);
    const r = await push();
    await pms.stop();
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("This week is already approved.");
    expect(pms.writes()).toEqual([]);
  });
});

describe("a token kept in config.toml", () => {
  async function withInlineToken(token: string) {
    const pms = await startMockPms();
    const sb = await sandbox();
    const map = Object.entries(MAP)
      .map(([project, task]) => `[[timesheet.map]]\nproject = "${project}"\nerp_task = "${task}"`)
      .join("\n\n");
    await sb.writeConfig(
      await fixtureSourcesToml(
        sb,
        `\n[timesheet]\ntype = "http"\nurl = "${pms.url}"\ntoken = "${token}"\n\n${map}\n`,
      ),
    );
    // No CLOCKOUT_TIMESHEET_TOKEN: the sandbox's environment has none.
    const push = (args: string[]) => sb.run(["push", DATE, "--no-ai", ...args]);
    return { pms, push };
  }

  it("sends with it, and never prints it, on a dry run or after", async () => {
    const { pms, push } = await withInlineToken("mock-token");
    const dry = await push(["--dry-run"]);
    const sent = await push(["--yes"]);
    await pms.stop();
    expect(dry.code).toBe(0);
    expect(sent.code).toBe(0);
    expect(sent.stdout).toContain("Sent 8 changes.");
    expect(new Set(pms.requests.map((x) => x.auth))).toEqual(new Set(["Bearer mock-token"]));
    for (const out of [dry, sent]) {
      expect(out.stdout).not.toContain("mock-token");
      expect(out.stderr).not.toContain("mock-token");
    }
  });

  it("says config.toml when the system refuses it, without printing it", async () => {
    const { pms, push } = await withInlineToken("a-wrong-inline-token");
    const r = await push(["--yes"]);
    await pms.stop();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refused the token in config.toml (Invalid token)");
    expect(r.stdout + r.stderr).not.toContain("a-wrong-inline-token");
  });
});

describe("a config from before the next-pms target was removed", () => {
  it("says what to change, and exits 1 with nothing on stdout", async () => {
    const sb = await sandbox();
    await sb.writeConfig(
      await fixtureSourcesToml(
        sb,
        `\n[timesheet]\ntype = "next-pms"\nurl = "https://erp.example.com"\n`,
      ),
    );
    const r = await sb.run(["push", DATE, "--no-ai", "--dry-run"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain('type = "next-pms" isn\'t supported any more');
    expect(r.stderr).toContain('type = "http"');
    expect(r.stderr).toContain("docs/timesheet-api.md");
  });
});
