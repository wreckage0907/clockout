import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { DATE, fixtures, type Sandbox, sandbox } from "./helpers";

// Export destinations from the command line (ADR 0010): `export --dest` writes the sheet where
// the export says, after showing it; a standup goes the same way.

let sb: Sandbox;

beforeAll(async () => {
  sb = await sandbox();
  await sb.writeConfig(`[me]
name = "Dev"
emails = ["dev@example.com"]
timezone = "Asia/Kolkata"

[ai]
backend = "none"

[[sources]]
type = "claude-code"
projects_dir = "${join(fixtures, "claude", "projects")}"

[[exports]]
name = "daily"
type = "markdown"
to = { file = "${join(sb.home, "Vault", "Daily", "{date}.md")}", append = true }

[[exports]]
name = "plain"
type = "csv"
`);
});

const note = () => readFile(join(sb.home, "Vault", "Daily", `${DATE}.md`), "utf8");
const noteExists = () =>
  note().then(
    () => true,
    () => false,
  );

describe("clockout export --dest", () => {
  it("writes the sheet where the export says, and says where", async () => {
    const r = await sb.run(["export", DATE, "-f", "daily", "--dest", "--yes"]);
    // The only thing on stderr is the day's open questions, not an error.
    expect(r.stderr).toContain("open questions");
    expect(r.code).toBe(0);
    // Shown as a path from your home folder, the way you'd write it.
    expect(r.stdout).toContain(`daily → ~/Vault/Daily/${DATE}.md (added to the end)`);
    expect(r.stdout).toMatch(/Wrote \d+ lines to/);
    const text = await note();
    expect(text).toContain(`| ${DATE} |`);
    expect(text).toContain("acme-api");
  });

  it("keeps its own block, so writing again is the same note and not a second table", async () => {
    const before = await note();
    const r = await sb.run(["export", DATE, "-f", "daily", "--dest", "--yes"]);
    expect(r.code).toBe(0);
    const after = await note();
    expect(after).toBe(before);
    expect(after.match(/<!-- clockout:start -->/g)).toHaveLength(1);
  });

  it("shows the text and where it goes on a dry run, and writes nothing", async () => {
    const before = await note();
    const r = await sb.run(["export", DATE, "-f", "daily", "--dest", "--dry-run"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("(dry run: nothing written)");
    expect(await note()).toBe(before);
  });

  it("refuses to write without --yes when there's nobody to ask", async () => {
    const r = await sb.run(["export", DATE, "-f", "daily", "--dest"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Add --yes to write it without being asked.");
  });

  it("says why a built-in format can't go anywhere", async () => {
    const r = await sb.run(["export", DATE, "-f", "csv", "--dest", "--yes"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("csv is built in and has no destination");
    expect(await noteExists()).toBe(true);
  });

  it("refuses --out together with --dest", async () => {
    const r = await sb.run(["export", DATE, "-f", "daily", "--dest", "-o", "x.csv"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("Give --out or --dest, not both");
  });
});

describe("clockout standup --to", () => {
  it("writes the standup into the same note, without touching the sheet", async () => {
    const before = await note();
    const r = await sb.run(["standup", DATE, "--to", "daily", "--yes", "--no-ai"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`daily → ~/Vault/Daily/${DATE}.md (added to the end)`);
    const after = await note();
    // The sheet's block is still there, and the standup has one of its own.
    expect(after.startsWith(before)).toBe(true);
    const added = after.slice(before.length);
    expect(added).toContain("<!-- clockout:standup:start -->");
    expect(added).toContain("Yesterday");
  });

  it("names the formats that have a destination when the one asked for has none", async () => {
    const r = await sb.run(["standup", DATE, "--to", "plain", "--yes", "--no-ai"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("plain has no destination");
  });
});
