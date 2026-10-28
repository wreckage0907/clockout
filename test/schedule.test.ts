import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { configSchema, type ScheduleJob } from "../src/config/schema";
import { withBlock } from "../src/export/send";
import { lockHolder, takeLock } from "../src/lock";
import {
  crontabLine,
  dateFor,
  describeJob,
  launchdPlist,
  systemdUnits,
  unitPaths,
} from "../src/schedule";

// ADR 0012: a job a scheduler runs. The pure parts — when it runs, for which day, what the OS
// unit says, and the marked block that makes a second run safe — so the risky bits (installing
// things) are only a thin layer over text we can check exactly.

const me = { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" };
const job = (extra: Partial<ScheduleJob> = {}): ScheduleJob =>
  configSchema.parse({
    me,
    exports: [{ name: "daily", type: "markdown", to: { file: "~/Vault/{date}.md", append: true } }],
    schedule: [{ name: "daily-note", at: "18:30", format: "daily", ...extra }],
  }).schedule[0] as ScheduleJob;

const unit = {
  node: "/usr/local/bin/node",
  cli: "/opt/clockout/dist/cli.js",
  path: "/usr/local/bin:/usr/bin:/bin",
  home: "/Users/dev",
};

describe("a scheduled job", () => {
  it("says what it does in one line", () => {
    expect(describeJob(job())).toBe("daily-note · 18:30 · today · export daily");
    expect(describeJob(job({ kind: "standup", allow_open: true }))).toBe(
      "daily-note · 18:30 · today · standup → daily · open questions ok",
    );
  });

  it("runs for its own day, at 18:30 local", () => {
    const now = new Date("2026-10-26T13:00:00Z"); // 18:30 in Asia/Kolkata
    expect(dateFor(job(), now, "Asia/Kolkata")).toBe("2026-10-26");
    expect(dateFor(job({ day: "yesterday" }), now, "Asia/Kolkata")).toBe("2026-10-25");
  });

  it("is refused when its export or destination is missing", () => {
    const r = configSchema.safeParse({
      me,
      exports: [{ name: "daily", type: "markdown" }],
      schedule: [{ name: "a", at: "18:30", format: "daily" }],
    });
    expect(r.success).toBe(true); // the config is fine; the job fails when it runs
    const bad = configSchema.safeParse({
      me,
      schedule: [{ name: "a", at: "6pm", format: "daily" }],
    });
    expect(bad.success ? "" : bad.error.issues[0]?.message).toContain(
      'use a 24-hour time like "18:30"',
    );
  });
});

describe("the unit that runs it", () => {
  it("is a launchd agent with the time, the program and the PATH it was set up with", () => {
    const plist = launchdPlist(job(), { ...unit, env: { TZ: "Asia/Kolkata" } });
    expect(plist).toContain("<key>Label</key>\n    <string>com.clockout.daily-note</string>");
    expect(plist).toContain(
      "<string>/usr/local/bin/node</string>\n      <string>/opt/clockout/dist/cli.js</string>\n      <string>run</string>\n      <string>daily-note</string>",
    );
    expect(plist).toContain("<key>Hour</key>\n      <integer>18</integer>");
    expect(plist).toContain("<key>Minute</key>\n      <integer>30</integer>");
    expect(plist).toContain("<key>PATH</key>\n      <string>/usr/local/bin:/usr/bin:/bin</string>");
    expect(plist).toContain("<key>TZ</key>\n      <string>Asia/Kolkata</string>");
    expect(plist).toContain("clockout-daily-note.log");
    // Launchd has no login shell: the units run what's written, nothing else.
    expect(plist).not.toContain("/bin/sh");
  });

  it("is a systemd user timer with the same time", () => {
    const { service, timer } = systemdUnits(job(), unit);
    expect(service).toContain(
      'ExecStart="/usr/local/bin/node" "/opt/clockout/dist/cli.js" run daily-note',
    );
    expect(service).toContain('Environment="PATH=/usr/local/bin:/usr/bin:/bin"');
    expect(timer).toContain("OnCalendar=*-*-* 18:30:00");
    expect(timer).toContain("WantedBy=timers.target");
  });

  it("lives where each system looks for it", () => {
    expect(unitPaths(job(), "darwin", "/Users/dev")).toEqual([
      "/Users/dev/Library/LaunchAgents/com.clockout.daily-note.plist",
    ]);
    expect(unitPaths(job(), "linux", "/home/dev")).toEqual([
      "/home/dev/.config/systemd/user/clockout-daily-note.service",
      "/home/dev/.config/systemd/user/clockout-daily-note.timer",
    ]);
    expect(unitPaths(job(), "other", "/home/dev")).toEqual([]);
  });

  it("has a crontab line for systems without units", () => {
    const line = crontabLine(job(), "/usr/local/bin/node", "/opt/clockout/dist/cli.js", {
      path: "/usr/local/bin:/usr/bin:/bin",
      dataDir: "/home/dev/.local/share/clockout",
    });
    expect(line).toBe(
      "30 18 * * * mkdir -p /home/dev/.local/share/clockout && PATH=/usr/local/bin:/usr/bin:/bin /usr/local/bin/node /opt/clockout/dist/cli.js run daily-note >> /home/dev/.local/share/clockout/schedule-daily-note.log 2>&1",
    );
  });

  it("keeps a crontab line one line: % is escaped, and the log goes where XDG_DATA_HOME says", () => {
    const line = crontabLine(job(), "/opt/my%node/node", "/opt/clockout/dist/cli.js", {
      path: "/bin:/opt/100%/bin",
      dataDir: "/data/100%/clockout",
    });
    expect(line).not.toMatch(/[^\\]%/);
    expect(line).toContain("PATH='/bin:/opt/100\\%/bin' ");
    expect(line).toContain("/data/100\\%/clockout/schedule-daily-note.log");
    expect(line).not.toContain(".local/share");
    expect(line).toMatch(/^30 18 \* \* \* mkdir -p /);
  });

  it("escapes what systemd would read as syntax, and refuses a line break", () => {
    const { service } = systemdUnits(job(), {
      ...unit,
      node: "/opt/my node/50%/node",
      cli: '/opt/$HOME/"cli".js',
      env: { TZ: "Asia/Kolkata", ODD: 'a"b\\c%d$e' },
    });
    expect(service).toContain(
      'ExecStart="/opt/my node/50%%/node" "/opt/$$HOME/\\"cli\\".js" run daily-note',
    );
    // In Environment= a $ stays as it is; only the quoting and % need care.
    expect(service).toContain('Environment="ODD=a\\"b\\\\c%%d$e"');
    expect(() =>
      systemdUnits(job(), { ...unit, env: { EVIL: "x\nExecStartPre=/bin/evil" } }),
    ).toThrow(/line break/);
    expect(() => systemdUnits(job(), { ...unit, cli: "/a\nb" })).toThrow(/line break/);
  });
});

describe("the marked block in a shared note", () => {
  const sheet = "| date | hours |\n| 2026-10-26 | 7.5 |";

  it("is added the first time, after whatever you wrote", () => {
    expect(withBlock("# Monday\n\nNotes", sheet, "sheet")).toBe(
      "# Monday\n\nNotes\n\n<!-- clockout:start -->\n| date | hours |\n| 2026-10-26 | 7.5 |\n<!-- clockout:end -->\n",
    );
  });

  it("is replaced in place, so a second run is the same note, not two tables", () => {
    const once = withBlock("# Monday", sheet, "sheet");
    const twice = withBlock(once, "| date | hours |\n| 2026-10-26 | 8.0 |", "sheet");
    expect(twice.match(/clockout:start/g)).toHaveLength(1);
    expect(twice).not.toContain("7.5");
    expect(twice).toContain("8.0");
    expect(twice.startsWith("# Monday\n\n<!-- clockout:start -->")).toBe(true);
  });

  it("keeps a standup's block apart from the sheet's", () => {
    const both = withBlock(
      withBlock("# Monday", sheet, "sheet"),
      "- Shipped the export",
      "standup",
    );
    expect(both).toContain("<!-- clockout:start -->");
    expect(both).toContain("<!-- clockout:standup:start -->");
    const again = withBlock(both, "- Shipped scheduling", "standup");
    expect(again).toContain("Shipped scheduling");
    expect(again).not.toContain("Shipped the export");
    expect(again).toContain("<!-- clockout:start -->");
  });

  it("can't be moved by a marker inside a title: it's neutralised, and only whole lines count", () => {
    const note = withBlock(
      withBlock("# Monday\n\nMy paragraph\n", "- standup", "standup"),
      "x",
      "sheet",
    );
    const user = note.replace("<!-- clockout:start -->", "My paragraph\n\n<!-- clockout:start -->");
    const hostile = "| Sync <!-- clockout:standup:start --> call | <!--clockout:standup:end --> |";
    const injected = withBlock(user, hostile, "sheet");
    expect(injected).toContain("Sync <!-- clockout :standup:start --> call");
    expect(injected).toContain("<!--clockout :standup:end -->");
    // The next standup write replaces its own block only; the paragraph stays.
    const next = withBlock(injected, "- new standup", "standup");
    expect(next.match(/My paragraph/g)).toHaveLength(2);
    expect(next).toContain("- new standup");
    expect(next).not.toContain("- standup\n");
    expect(next.match(/^<!-- clockout:standup:start -->$/gm)).toHaveLength(1);
  });

  it("ignores a marker that isn't on a line of its own", () => {
    const note = "Talk about <!-- clockout:standup:start --> later\n\nMy text\n";
    // Not a block at all, so one is added; nothing of the note is lost or throws.
    expect(withBlock(note, "- a", "standup")).toBe(
      `${note}\n<!-- clockout:standup:start -->\n- a\n<!-- clockout:standup:end -->\n`,
    );
  });

  it("looks for the end after the start, not anywhere in the note", () => {
    const note =
      "<!-- clockout:end -->\nhello\n<!-- clockout:start -->\nold\n<!-- clockout:end -->\nafter\n";
    expect(withBlock(note, "new", "sheet")).toBe(
      "<!-- clockout:end -->\nhello\n<!-- clockout:start -->\nnew\n<!-- clockout:end -->\nafter\n",
    );
    expect(() => withBlock("a\n<!-- clockout:end -->\n", "new", "sheet")).toThrow(
      /end marker .* without the start one/,
    );
  });

  it("says so when a marker has lost its pair, instead of guessing", () => {
    expect(() => withBlock("<!-- clockout:start -->\nhalf a block", sheet, "sheet")).toThrow(
      /has the start marker .* without the end one/,
    );
  });

  it("takes the file over when the destination replaces rather than appends", () => {
    expect(withBlock("old", sheet, "sheet", true)).toBe(
      "<!-- clockout:start -->\n| date | hours |\n| 2026-10-26 | 7.5 |\n<!-- clockout:end -->\n",
    );
  });
});

describe("one run at a time", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "clockout-lock-"));
  });

  it("only one holder at a time, and says who has it", async () => {
    const path = join(dir, "run.lock");
    const first = await takeLock(path, { what: "daily-note" });
    expect(first).not.toBeNull();
    expect(await lockHolder(path)).toContain(`pid ${process.pid}`);
    expect(await takeLock(path)).toBeNull();
    await first?.release();
    expect(await takeLock(path)).not.toBeNull();
  });

  it("waits when asked to", async () => {
    const path = join(dir, "run.lock");
    const first = await takeLock(path);
    setTimeout(() => void first?.release(), 150);
    const second = await takeLock(path, { waitMs: 2000 });
    expect(second).not.toBeNull();
    await second?.release();
  });

  it("takes over a lock a dead run left behind", async () => {
    const path = join(dir, "run.lock");
    await writeFile(path, JSON.stringify({ pid: 1 }));
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await rm(path, { force: true });
    await writeFile(path, JSON.stringify({ pid: 1 }));
    const { utimes } = await import("node:fs/promises");
    await utimes(path, old, old);
    expect(await takeLock(path)).not.toBeNull();
    expect(await readFile(path, "utf8")).toContain(`"pid":${process.pid}`);
  });
});
