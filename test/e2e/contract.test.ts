import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import pkg from "../../package.json" with { type: "json" };
import { DATE, type Sandbox, sandbox } from "./helpers";

// What the built CLI promises scripts: the exit code, what goes to stdout, and a one-line
// reason on stderr (no stack traces), checked separately for each case.

const CONFIG = `[me]
name = "Dev"
emails = ["dev@example.com"]
timezone = "Asia/Kolkata"

[ai]
backend = "none"
`;

let none: Sandbox;
let set: Sandbox;
beforeAll(async () => {
  none = await sandbox();
  set = await sandbox();
  await set.writeConfig(CONFIG);
});

/** stderr's first line, which carries the reason. */
const reason = (stderr: string) => stderr.split("\n")[0];

describe("without a config", () => {
  it("prints the version and help", async () => {
    expect(await none.run(["--version"])).toEqual({
      code: 0,
      stdout: `${pkg.version}\n`,
      stderr: "",
    });
    const help = await none.run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("Usage: clockout [options] [command]");
    expect(help.stderr).toBe("");
  });

  it.each([["today", "--plain"], ["export"], ["push"], ["undo"]])(
    "`%s` says to run init",
    async (...args) => {
      expect(await none.run(args)).toEqual({
        code: 1,
        stdout: "",
        stderr:
          "clockout: No config at ~/.config/clockout/config.toml. Run `clockout init` first.\n",
      });
    },
  );

  it("init refuses without a terminal", async () => {
    const r = await none.run(["init"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(reason(r.stderr)).toBe(
      "clockout: clockout init asks questions, so it needs an interactive terminal.",
    );
  });
});

describe("arguments", () => {
  it.each([
    [
      ["yesteday"],
      'clockout: Unknown command "yesteday". Did you mean yesterday? See clockout --help.',
    ],
    [["frobnicate"], 'clockout: Unknown command "frobnicate". See clockout --help.'],
    [["day", DATE, "--frobnicate"], "error: unknown option '--frobnicate'"],
    [["day"], "error: missing required argument 'date'"],
    [
      ["day", "someday"],
      'clockout: Can\'t read the date "someday". Use today, yesterday, -2 or YYYY-MM-DD.',
    ],
    [
      ["day", "2026-02-30"],
      'clockout: Can\'t read the date "2026-02-30". Use today, yesterday, -2 or YYYY-MM-DD.',
    ],
    [
      ["day", "2099-01-01", "--plain"],
      /^clockout: 2099-01-01 hasn't happened yet; today is \d{4}-\d{2}-\d{2}\.$/,
    ],
    [["export", DATE, "-f", "xml"], 'clockout: Unknown format "xml". Use csv, md, tsv, json.'],
    [
      ["export", DATE, "--from", DATE],
      `clockout: Give a date or --from/--to, not both (got "${DATE}" too).`,
    ],
    [
      ["export", "--from", DATE, "--to", "2026-10-01"],
      `clockout: --to (2026-10-01) is before --from (${DATE}).`,
    ],
    [
      ["export", "--from", "2026-01-01", "--to", DATE],
      "clockout: That's more than 62 days; export a shorter range.",
    ],
    [
      ["connect", "dropbox"],
      'clockout: There\'s no MCP server called "dropbox" in your config. Give its address: clockout connect dropbox https://example.com/mcp',
    ],
    [
      ["connect", "Drop Box"],
      /^clockout: Connect "google" \(your calendar\), "erp" \(where your timesheet goes\) or an MCP server/,
    ],
    [
      ["connect", "erp", "http://erp.example.com"],
      "clockout: Use your ERP's https:// address (got http://erp.example.com).",
    ],
    [
      ["connect", "erp", "not a url"],
      `clockout: "not a url" isn't a web address. Use e.g. https://erp.example.com`,
    ],
    [
      ["push", DATE],
      "clockout: No ERP is set up. Run `clockout connect erp https://your-erp.example.com`.",
    ],
  ])("%j fails with one readable line and nothing on stdout", async (args, expected) => {
    const r = await set.run(args);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    if (typeof expected === "string") expect(reason(r.stderr)).toBe(expected);
    else expect(reason(r.stderr)).toMatch(expected);
    expect(r.stderr).not.toMatch(/\n\s+at /); // no stack trace
  });
});

describe("files it can't write", () => {
  it("says why, and where the details are", async () => {
    const r = await set.run(["export", DATE, "-o", join(set.home, "missing", "x.csv")]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toBe(
      "clockout: Can't write ~/missing/x.csv: its folder doesn't exist.\nDetails: ~/.local/share/clockout/errors.log\n",
    );
    const dir = await set.run(["export", DATE, "-o", set.home]);
    expect(reason(dir.stderr)).toBe(`clockout: Can't write ~: it's a folder; give a file name.`);
  });
});

describe("a broken config", () => {
  it.each([
    ["", /It's empty\. Run `clockout init --force` to write one\./],
    [
      "[me\nname = ",
      /^clockout: Problem in ~\/\.config\/clockout\/config\.toml:\nInvalid TOML document/,
    ],
    ['[me]\nname = "Dev"\nemails = ["dev@example.com"]\ntimezone = "Nowhere/Land"\n', /timezone/],
  ])("says what's wrong in it: %j", async (toml, expected) => {
    const sb = await sandbox();
    await mkdir(sb.config, { recursive: true });
    await writeFile(join(sb.config, "config.toml"), toml);
    const r = await sb.run(["export", DATE]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(expected);
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });
});

describe("a damaged saved day", () => {
  it("names the file and how to fix it, instead of overwriting it", async () => {
    const sb = await sandbox();
    await sb.writeConfig(CONFIG);
    await mkdir(join(sb.data, "days"), { recursive: true });
    await writeFile(join(sb.data, "days", `${DATE}.json`), '{"version": 1, "da');
    const r = await sb.run(["export", DATE]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(reason(r.stderr)).toBe(
      `clockout: The saved day ~/.local/share/clockout/days/${DATE}.json is damaged. Move it aside (or delete it) to rebuild the day from your activity; corrections made on it are lost.`,
    );
  });
});
