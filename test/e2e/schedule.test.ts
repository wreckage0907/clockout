import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { type Sandbox, sandbox } from "./helpers";

// ADR 0012 from the outside: a job set up once runs by itself, writes its own marked block,
// doesn't write the same day twice, and exits 1 when the sheet it wrote was still unfinished.
// Installing the OS unit isn't exercised here (that's `schedule print` plus a unit test): a test
// run must never touch your launchd or systemd.

const TZ = "Asia/Kolkata";
const today = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());
const at = (hhmm: string) => new Date(`${today}T${hhmm}:00+05:30`).toISOString();

let sb: Sandbox;
const note = (date = today) => readFile(join(sb.home, "Vault", `${date}.md`), "utf8");
const noteExists = (date = today) =>
  note(date).then(
    () => true,
    () => false,
  );
const runs = () => readFile(join(sb.data, "runs.log"), "utf8").catch(() => "");

/** A Claude Code session today, so the day has something to put on the sheet. */
async function sessionFor(dir: string, folder: string, prompts: string[]) {
  const project = join(dir, folder);
  await mkdir(project, { recursive: true });
  const lines = [
    { type: "ai-title", aiTitle: "Ship the export", sessionId: "sched-1" },
    ...prompts.flatMap((p, i) => [
      {
        type: "user",
        isSidechain: false,
        userType: "external",
        cwd: "/Users/dev/code/acme-api",
        gitBranch: "feat/export",
        sessionId: "sched-1",
        timestamp: at(p),
        message: { role: "user", content: `work on the export (${i + 1})` },
      },
      {
        type: "assistant",
        isSidechain: false,
        sessionId: "sched-1",
        timestamp: at(p),
        message: { role: "assistant", content: [{ type: "text", text: "ok" }] },
      },
    ]),
  ];
  await writeFile(
    join(project, "sched-1.jsonl"),
    `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
  );
}

beforeAll(async () => {
  sb = await sandbox();
  const projects = join(sb.home, "claude-projects");
  // Prompts from the start to the end of the working hours: one block, no gaps to ask about.
  await sessionFor(projects, "-Users-dev-code-acme-api", [
    "10:00",
    "10:15",
    "10:30",
    "10:45",
    "10:55",
  ]);
  await sb.writeConfig(`[me]
name = "Dev"
emails = ["dev@example.com"]
timezone = "${TZ}"

[day]
working_hours = "10:00-11:00"

[ai]
backend = "none"

[[sources]]
type = "claude-code"
projects_dir = "${projects}"

[[exports]]
name = "daily"
type = "markdown"
to = { file = "${join(sb.home, "Vault", "{date}.md")}", append = true }

[[schedule]]
name = "daily-note"
at = "18:30"
format = "daily"

[[schedule]]
name = "last-night"
at = "02:00"
day = "yesterday"
format = "daily"
`);
});

describe("clockout schedule", () => {
  it("shows each job with the day it covers and where it writes", async () => {
    const r = await sb.run(["schedule"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("daily-note · 18:30 · today · export daily");
    expect(r.stdout).toContain("last-night · 02:00 · yesterday · export daily");
    expect(r.stdout).toContain("→ ~/Vault/");
    expect(r.stdout).toContain("(added to the end)");
    // Nothing was installed in this sandbox, and it says so rather than claiming otherwise.
    expect(r.stdout).toContain("not installed");
    expect(r.stdout).not.toContain(" · installed");
  });

  it("prints the unit without installing anything", async () => {
    const r = await sb.run(["schedule", "print", "daily-note"]);
    expect(r.code).toBe(0);
    // Whatever this machine is, the text says what would run and when.
    expect(r.stdout).toMatch(
      /com\.clockout\.daily-note\.plist|clockout-daily-note\.timer|Add it with/,
    );
    expect(r.stdout).toMatch(/18/);
    expect(await noteExists()).toBe(false);
    expect(await readFile(join(sb.home, "Library", "LaunchAgents"), "utf8").catch(() => "")).toBe(
      "",
    );
  });
});

describe("clockout run", () => {
  it("writes today's rows into the note's own block", async () => {
    const r = await sb.run(["run", "daily-note"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("daily-note ·");
    expect(r.stdout).toContain("→ ~/Vault/");
    expect(r.stdout).toMatch(/1 row|2 rows/);
    const text = await note();
    expect(text).toContain("<!-- clockout:start -->");
    expect(text).toContain("<!-- clockout:end -->");
    expect(text).toContain("acme-api");
    expect(text).not.toContain("open question");
    expect(r.stderr).toBe("");
  });

  it("records the run where `schedule log` reads it", async () => {
    await sb.run(["run", "daily-note"]);
    const r = await sb.run(["schedule", "log"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Z daily-note · \d{4}-\d\d-\d\d · /);
    expect(await runs()).toContain("daily-note");
  });

  it("doesn't write the same day twice", async () => {
    const before = await note();
    const r = await sb.run(["run", "daily-note"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toContain("was written already (--again writes it again)");
    expect(await note()).toBe(before);
    expect(await runs()).toContain("skipped");
  });

  it("writes it again when asked, replacing its block rather than adding another", async () => {
    const r = await sb.run(["run", "daily-note", "--again"]);
    expect(r.code).toBe(0);
    const text = await note();
    expect(text.match(/<!-- clockout:start -->/g)).toHaveLength(1);
    expect(text.match(/acme-api/g)?.length).toBe(1);
  });

  it("shows what it would write on a dry run, and keeps it out of the log", async () => {
    const before = await runs();
    const r = await sb.run(["run", "daily-note", "--again", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("would write");
    expect(await runs()).toBe(before);
  });

  it("says there's no such job", async () => {
    const r = await sb.run(["run", "nope"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('There\'s no scheduled job called "nope"');
  });

  it("exits 1 when the day it wrote still has open questions", async () => {
    // Yesterday here has no sessions at all: a whole working day of gaps, each a question.
    const r = await sb.run(["run", "last-night"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("open question");
    expect(r.stderr).toBe("");
  });
});

describe("a job that's fine with an unfinished sheet", () => {
  it("exits 0 when the day still has open questions", async () => {
    const lenient = await sandbox();
    await lenient.writeConfig(`[me]
name = "Dev"
emails = ["dev@example.com"]
timezone = "${TZ}"

[day]
working_hours = "10:00-11:00"

[ai]
backend = "none"

[[exports]]
name = "daily"
type = "text"
line = "{project}"
to = { file = "${join(lenient.home, "note.md")}", append = true }

[[schedule]]
name = "midday"
at = "13:00"
day = "yesterday"
allow_open = true
format = "daily"
`);
    const r = await lenient.run(["run", "midday"]);
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(await readFile(join(lenient.home, "note.md"), "utf8")).toContain("clockout:start");
  });
});

describe("clockout schedule add and remove", () => {
  it("adds a job, shows what it does, and can be removed again", async () => {
    const free = await sandbox();
    await free.writeConfig(`[me]
name = "Dev"
emails = ["dev@example.com"]
timezone = "${TZ}"

[ai]
backend = "none"

[[exports]]
name = "daily"
type = "text"
line = "{project}"
to = { file = "${join(free.home, "note.md")}", append = true }
`);
    const added = await free.run([
      "schedule",
      "add",
      "evening",
      "--at",
      "19:45",
      "--for",
      "yesterday",
      "-f",
      "daily",
      "--print",
    ]);
    expect(added.code).toBe(0);
    expect(added.stdout).toContain("Added evening: 19:45 every day, for yesterday.");
    expect(added.stdout).toContain("That's the confirmation: after this it writes without asking.");
    expect(added.stdout).toContain("Nothing installed.");
    expect(await readFile(join(free.config, "config.toml"), "utf8")).toContain(
      '[[schedule]]\nname = "evening"\nat = "19:45"',
    );

    const listed = await free.run(["schedule"]);
    expect(listed.stdout).toContain("evening · 19:45 · yesterday · export daily");

    const removed = await free.run(["schedule", "remove", "evening"]);
    expect(removed.code).toBe(0);
    expect(await readFile(join(free.config, "config.toml"), "utf8")).not.toContain(
      'name = "evening"',
    );
  });

  it("refuses a job whose export has no destination", async () => {
    const walled = await sandbox();
    await walled.writeConfig(`[me]
name = "Dev"
emails = ["dev@example.com"]
timezone = "${TZ}"

[ai]
backend = "none"

[[exports]]
name = "plain"
type = "csv"
`);
    const r = await walled.run(["schedule", "add", "job", "-f", "plain", "--print"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('"plain", which has no destination');
  });

  it("refuses a time it can't read", async () => {
    const r = await sb.run(["schedule", "add", "job", "--at", "6pm", "-f", "daily", "--print"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('use a 24-hour time like "18:30"');
  });
});
