import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DATE, fixtureSourcesToml, type Sandbox, sandbox } from "../e2e/helpers";
import { startMockPms } from "../mock-pms/server";
import { hasPython, KEY, type PtyRun, RESTORE, runInPty } from "./helpers";

// The review screen in a real terminal: Ink starts, keys and pastes arrive the way a terminal
// sends them, the window is resized, and on the way out (Ctrl+C, a kill, a closed terminal) the
// terminal is left as it was. CI always has python3; a machine without it skips these.

/** The home screen has drawn: the day's hours against the target. */
const HOME = "of 8h";
/** The day view has drawn its first card. */
const DAY = "Fix auth token refresh";

/** What was written after the last time `text` was drawn: the way out. */
const after = (r: PtyRun, text: string) => r.output.slice(r.output.lastIndexOf(text));

function expectRestored(tail: string) {
  expect(tail).toContain(RESTORE.mouseOff);
  expect(tail).toContain(RESTORE.mainScreen);
  expect(tail).toContain(RESTORE.cursorShown);
}

const canRun = hasPython || !!process.env.CI;
// Longer than drive.py's 30s, so a stuck step fails with what was on screen, not a bare timeout.
const timeout = 40_000;

describe.runIf(canRun)("the review screen in a terminal", { timeout }, () => {
  let sb: Sandbox;
  beforeAll(async () => {
    sb = await sandbox();
    await sb.writeConfig(await fixtureSourcesToml(sb));
  });

  it("opens the day with Enter, and Ctrl+C leaves the terminal as it was", async () => {
    const r = await runInPty(
      sb,
      ["day", DATE],
      [{ wait: HOME }, { send: KEY.enter }, { wait: DAY }, { send: KEY.ctrlC }],
    );
    expect(r.failed).toBeNull();
    expect(r.code).toBe(0);
    expectRestored(after(r, DAY));
  });

  it.each(["/quit", "/exit"])("leaves with %s, the terminal as it was", async (command) => {
    const r = await runInPty(
      sb,
      ["day", DATE],
      [{ wait: HOME }, { send: KEY.paste(command) }, { wait: command }, { send: KEY.enter }],
    );
    expect(r.failed).toBeNull();
    expect(r.code).toBe(0);
    expectRestored(after(r, HOME));
  });

  it("puts a paste in the chat bar without sending it, and Enter sends it", async () => {
    const r = await runInPty(
      sb,
      ["day", DATE],
      [
        { wait: HOME },
        { send: KEY.paste("/date 2026-10-15\n") },
        { wait: "/date 2026-10-15" },
        { absent: "Oct 15", within: 1 },
        { send: KEY.enter },
        { wait: "Oct 15" },
        { send: KEY.ctrlC },
      ],
    );
    expect(r.failed).toBeNull();
    expect(r.code).toBe(0);
  });

  it("asks for a bigger window when it's too small, and comes back as it was", async () => {
    const r = await runInPty(
      sb,
      ["day", DATE],
      [
        { wait: HOME },
        { resize: [50, 14] },
        { wait: "Make the window bigger" },
        { resize: [100, 30] },
        { wait: HOME },
        { send: KEY.ctrlC },
      ],
    );
    expect(r.failed).toBeNull();
    expect(r.code).toBe(0);
  });

  it.each([
    ["TERM", 143],
    ["HUP", 129],
  ] as const)("restores the terminal when killed with SIG%s", async (signal, code) => {
    const r = await runInPty(sb, ["day", DATE], [{ wait: HOME }, { signal }]);
    expect(r.failed).toBeNull();
    expect(r.code).toBe(code);
    expectRestored(after(r, HOME));
  });

  it("quits at once on Ctrl+C while an AI helper hangs, and stops the helper", async () => {
    const ai = await sandbox();
    await ai.writeConfig(
      (await fixtureSourcesToml(ai)).replace('backend = "none"', 'backend = "claude-code"'),
    );
    // A `claude` that never answers, and starts a process of its own that would keep running.
    const pids = join(ai.home, "pids");
    const stub = join(ai.home, "bin", "claude");
    await writeFile(
      stub,
      `#!/bin/sh\n[ "$1" = "--version" ] && { echo "2.1.0 (Claude Code)"; exit 0; }\n/bin/sleep 300 &\necho "$$ $!" >> ${pids}\nwait\n`,
    );
    await chmod(stub, 0o755);
    const started = Date.now();
    const r = await runInPty(
      ai,
      ["day", DATE, "--refresh"],
      [{ wait: "Drafting" }, { sleep: 0.5 }, { send: KEY.ctrlC }],
    );
    expect(r.failed).toBeNull();
    expect(r.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    const running = (await readFile(pids, "utf8"))
      .split(/\s+/)
      .filter(Boolean)
      .map(Number)
      .filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
    expect(running).toEqual([]);
    expectRestored(after(r, "Drafting"));
  });

  it("sends the day to a PMS with Ctrl+S and Enter", async () => {
    const pms = await startMockPms();
    const send = await sandbox();
    // No calendar: no meetings waiting for an answer, so the day can be sent as it is.
    const toml = (await fixtureSourcesToml(send)).replace(
      /\[\[sources\]\]\ntype = "calendar"[\s\S]*$/,
      "",
    );
    await send.writeConfig(`${toml}
[timesheet]
type = "http"
url = "${pms.url}"

[[timesheet.map]]
project = "acme/api"
erp_task = "TASK-API"

[[timesheet.map]]
project = "dev-example/clockout"
erp_task = "TASK-TOOLS"
`);
    const r = await runInPty(
      send,
      ["day", DATE],
      [
        { wait: HOME },
        { send: KEY.enter },
        { wait: DAY },
        { send: KEY.ctrlS },
        // The panel's own title; the header's "Send to ERP" button is there from the start.
        { wait: "from Clockout" },
        { send: KEY.enter },
        { wait: "✓ Sent" },
        { send: KEY.ctrlC },
      ],
      { env: { CLOCKOUT_TIMESHEET_TOKEN: pms.token } },
    );
    await pms.stop();
    expect(r.failed).toBeNull();
    expect(r.code).toBe(0);
    expect(pms.day(DATE).length).toBeGreaterThan(5);
    expect(new Set(pms.day(DATE).map((e) => e.task))).toEqual(new Set(["TASK-API", "TASK-TOOLS"]));
  });

  it("/connect google signs in again even when a stale sign-in is on disk", async () => {
    const g = await sandbox();
    await g.writeConfig(`${await fixtureSourcesToml(g)}
[google]
client_id = "test-client-id.apps.googleusercontent.com"
client_secret = "test-secret"
`);
    // A revoked or expired sign-in still sits in credentials.json, the way Google's weekly
    // "Testing" refresh-token expiry leaves it; connecting must replace it, not skip the browser.
    await writeFile(
      join(g.config, "credentials.json"),
      `${JSON.stringify(
        {
          google: {
            refresh_token: "stale-token",
            client_id: "stale-client-id.apps.googleusercontent.com",
            scope: "https://www.googleapis.com/auth/calendar.events.readonly",
            connected_at: "2026-10-01T00:00:00.000Z",
          },
        },
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    // A stand-in for the browser: `open` records what it was asked to open.
    const openLog = join(g.home, "open.log");
    const open = join(g.home, "bin", "open");
    await writeFile(open, `#!/bin/sh\nprintf '%s\\n' "$@" >> "$OPEN_LOG"\n`);
    await chmod(open, 0o755);

    const r = await runInPty(
      g,
      ["day", DATE],
      [
        { wait: HOME },
        { send: KEY.paste("/connect google") },
        { wait: "/connect google" },
        { send: KEY.enter },
        { wait: "Finish signing in in your browser" },
        { sleep: 1 },
        // The sign-in is still waiting on the browser, so Ctrl+C wouldn't end it; a TERM does.
        { signal: "TERM" },
      ],
      { env: { OPEN_LOG: openLog } },
    );
    expect(r.failed).toBeNull();
    expect(r.code).toBe(143);
    const opened = await readFile(openLog, "utf8").catch(() => "");
    expect(opened).toContain("https://accounts.google.com/o/oauth2/v2/auth");
    expectRestored(after(r, "Finish signing in in your browser"));
  });
});
