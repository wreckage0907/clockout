import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { settingsContext } from "../../src/ai/edits";
import { destinationExport, saveToDestination } from "../../src/commands/dest";
import { type ConfigInput, configSchema } from "../../src/config/schema";
import { applySettings } from "../../src/config/setting-ops";
import {
  describeDestination,
  destinationOf,
  filePath,
  planDestination,
  writeDestination,
} from "../../src/export/send";
import { type MockMcp, startMockMcp } from "../mock-mcp/server";

// Export destinations (ADR 0010): a file such as an Obsidian daily note, or one tool on a
// connected MCP server. Previewed, then written on a yes.

const me = { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" };
const config = (exports: ConfigInput["exports"]) => configSchema.parse({ me, exports });

let dir: string;
const dataHome = process.env.XDG_DATA_HOME;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clockout-dest-"));
  // The note's lock file goes in the data folder: a temporary one, not yours.
  process.env.XDG_DATA_HOME = join(dir, "data");
});
afterEach(() => {
  if (dataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = dataHome;
});

const capture = async (run: () => Promise<void>) => {
  const out: string[] = [];
  const log = console.log;
  console.log = (line: string) => void out.push(line);
  try {
    await run();
  } finally {
    console.log = log;
  }
  return out.join("\n");
};

describe("a destination in the config", () => {
  it("takes a file, with {date} filled in, and says whether it's added to or replaces", () => {
    const c = config([
      { name: "daily", type: "markdown", to: { file: "~/Vault/Daily/{date}.md", append: true } },
    ]);
    const format = c.exports[0];
    expect(destinationOf(format)).toEqual({ file: "~/Vault/Daily/{date}.md", append: true });
    expect(describeDestination(format?.to ?? { file: "" }, "2026-10-16", "/home/dev")).toBe(
      "~/Vault/Daily/2026-10-16.md (added to the end)",
    );
    expect(filePath("~/Vault/Daily/{date}.md", "2026-10-16", "/home/dev")).toBe(
      "/home/dev/Vault/Daily/2026-10-16.md",
    );
    expect(filePath("/srv/notes/{date}.md", "2026-10-16", "/home/dev")).toBe(
      "/srv/notes/2026-10-16.md",
    );
  });

  it("takes an MCP server and one of its tools", () => {
    const c = config([
      {
        name: "notion",
        type: "markdown",
        to: {
          mcp: "notion",
          tool: "append_block",
          arguments: { page: "Worklog", content: "{text}" },
        },
      },
    ]);
    expect(describeDestination(c.exports[0]?.to ?? { mcp: "", tool: "" }, "2026-10-16")).toBe(
      "notion · append_block (page, content)",
    );
  });

  it("refuses a field it can't fill in", () => {
    const r = configSchema.safeParse({
      me,
      exports: [{ name: "daily", type: "markdown", to: { file: "~/Vault/{week}.md" } }],
    });
    expect(r.success ? "" : r.error.issues[0]?.message).toContain("use {text} and {date}");
  });
});

describe("planning what would be written", () => {
  it("says the file is there already, so replacing it is a question", async () => {
    const plan = await planDestination({ file: "~/notes/{date}.md" }, "# Friday\n", {
      date: "2026-10-16",
      home: "/home/dev",
      exists: async () => true,
    });
    expect(plan).toMatchObject({
      kind: "file",
      where: "~/notes/2026-10-16.md (replaced)",
      path: "/home/dev/notes/2026-10-16.md",
      exists: true,
    });
  });
});

describe("writing a file destination", () => {
  it("writes a new file, folders and all", async () => {
    const path = join(dir, "Vault", "Daily", "2026-10-16.md");
    const c = config([{ name: "daily", type: "markdown", to: { file: path } }]);
    const format = destinationExport(c, "daily");
    const text = "| Date | Project |\n| 2026-10-16 | acme/api |";
    const said = await capture(() =>
      saveToDestination(c, format, text, "2026-10-16", { yes: true }),
    );
    expect(said).toContain(`daily → ${path.replace("/home", "/home")} (replaced)`);
    expect(said).toContain("Wrote 2 lines to");
    expect(await readFile(path, "utf8")).toBe(`${text}\n`);
  });

  it("keeps its own block in a note it shares, and replaces it next time", async () => {
    const path = join(dir, "notes", "2026-10.md");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(dir, "notes"), { recursive: true });
    await writeFile(path, "# Worklog\n\nMonday");
    const c = config([
      { name: "log", type: "text", line: "{project}", to: { file: path, append: true } },
    ]);
    await capture(() =>
      saveToDestination(c, destinationExport(c, "log"), "Tuesday", "2026-10-16", { yes: true }),
    );
    expect(await readFile(path, "utf8")).toBe(
      "# Worklog\n\nMonday\n\n<!-- clockout:start -->\nTuesday\n<!-- clockout:end -->\n",
    );
    // Monday's own writing stays, and Tuesday isn't written a second time.
    await capture(() =>
      saveToDestination(c, destinationExport(c, "log"), "Tuesday again", "2026-10-16", {
        yes: true,
      }),
    );
    const after = await readFile(path, "utf8");
    expect(after.match(/clockout:start/g)).toHaveLength(1);
    expect(after).toContain("Tuesday again");
    expect(after).not.toMatch(/\nTuesday\n/);
    expect(after.startsWith("# Worklog\n\nMonday\n\n")).toBe(true);
  });

  it("doesn't write anything on a dry run", async () => {
    const path = join(dir, "dry.md");
    const c = config([{ name: "daily", type: "markdown", to: { file: path } }]);
    const said = await capture(() =>
      saveToDestination(c, destinationExport(c, "daily"), "text", "2026-10-16", { dryRun: true }),
    );
    expect(said).toContain("dry run: nothing written");
    await expect(readFile(path, "utf8")).rejects.toThrow();
  });

  it("asks before replacing a file that's there, and says what it does when told no", async () => {
    const path = join(dir, "there.md");
    await writeFile(path, "old");
    const c = config([{ name: "daily", type: "markdown", to: { file: path } }]);
    const said = await capture(async () => {
      // Not a terminal and no --yes: it refuses instead of writing over the note.
      await expect(
        saveToDestination(c, destinationExport(c, "daily"), "new", "2026-10-16", {
          interactive: false,
        }),
      ).rejects.toThrow("Add --yes to write it without being asked.");
    });
    expect(said).toContain("(replaced)");
    expect(await readFile(path, "utf8")).toBe("old");
  });
});

describe("writing a shared note safely", () => {
  const sharedConfig = (path: string) =>
    config([{ name: "log", type: "text", line: "{project}", to: { file: path, append: true } }]);
  const plan = (path: string, text: string, block?: "sheet" | "standup") =>
    planDestination({ file: path, append: true }, text, {
      date: "2026-10-16",
      ...(block ? { kind: block } : {}),
    });

  it("keeps a note's mode and writes through a symlink instead of replacing it", async () => {
    const { chmod, lstat, mkdir, readdir, symlink } = await import("node:fs/promises");
    await mkdir(join(dir, "vault"), { recursive: true });
    const real = join(dir, "vault", "note.md");
    const link = join(dir, "link.md");
    await writeFile(real, "# Mine\n");
    await chmod(real, 0o640);
    await symlink(real, link);
    const to = { file: link, append: true };
    await writeDestination(to, await plan(link, "- row"), { config: sharedConfig(link) });
    expect((await lstat(link)).isSymbolicLink()).toBe(true);
    expect(await readFile(real, "utf8")).toBe(
      "# Mine\n\n<!-- clockout:start -->\n- row\n<!-- clockout:end -->\n",
    );
    expect((await lstat(real)).mode & 0o777).toBe(0o640);
    // No temporary file is left next to it.
    expect(await readdir(join(dir, "vault"))).toEqual(["note.md"]);
  });

  it("creates a new note readable only by you", async () => {
    const { stat } = await import("node:fs/promises");
    const path = join(dir, "fresh.md");
    await writeDestination({ file: path, append: true }, await plan(path, "- row"), {
      config: sharedConfig(path),
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("leaves the note whole when the write fails part-way", async () => {
    const { chmod, readdir } = await import("node:fs/promises");
    if (process.getuid?.() === 0) return; // root ignores folder permissions
    const folder = join(dir, "locked");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(folder);
    const path = join(folder, "note.md");
    await writeFile(path, "precious\n");
    await chmod(folder, 0o500); // no new files in here, so the temporary file can't be made
    try {
      await expect(
        writeDestination({ file: path, append: true }, await plan(path, "- row"), {
          config: sharedConfig(path),
        }),
      ).rejects.toThrow("Can't write");
    } finally {
      await chmod(folder, 0o700);
    }
    expect(await readFile(path, "utf8")).toBe("precious\n");
    expect(await readdir(folder)).toEqual(["note.md"]);
  });

  it("keeps both blocks when a sheet and a standup are written at the same time", async () => {
    const path = join(dir, "both.md");
    await writeFile(path, "# Day\n");
    const to = { file: path, append: true };
    for (let round = 0; round < 5; round++)
      await Promise.all([
        writeDestination(to, await plan(path, `sheet ${round}`, "sheet"), {
          config: sharedConfig(path),
        }),
        writeDestination(to, await plan(path, `standup ${round}`, "standup"), {
          config: sharedConfig(path),
        }),
      ]);
    const note = await readFile(path, "utf8");
    expect(note).toContain("<!-- clockout:start -->\nsheet 4\n<!-- clockout:end -->");
    expect(note).toContain(
      "<!-- clockout:standup:start -->\nstandup 4\n<!-- clockout:standup:end -->",
    );
    expect(note.startsWith("# Day\n")).toBe(true);
    expect(note.match(/clockout:start/g)).toHaveLength(1);
    expect(note.match(/clockout:standup:start/g)).toHaveLength(1);
  });

  it("keeps your paragraph when a meeting title looks like a marker", async () => {
    const path = join(dir, "inject.md");
    const to = { file: path, append: true };
    const cfg = sharedConfig(path);
    await writeDestination(to, await plan(path, "- 09:00 Standup", "standup"), { config: cfg });
    // The user writes between the two blocks.
    const withNote = (await readFile(path, "utf8")).replace(
      "<!-- clockout:standup:start -->",
      "My own paragraph.\n\n<!-- clockout:standup:start -->",
    );
    await writeFile(path, withNote);
    await writeDestination(
      to,
      await plan(path, "| Sync <!-- clockout:standup:start --> call |", "sheet"),
      { config: cfg },
    );
    await writeDestination(to, await plan(path, "- 10:00 Review", "standup"), { config: cfg });
    const note = await readFile(path, "utf8");
    expect(note).toContain("My own paragraph.");
    expect(note).toContain("Sync <!-- clockout :standup:start --> call");
    expect(note).toContain("- 10:00 Review");
    expect(note).not.toContain("- 09:00 Standup");
  });
});

describe("writing to an MCP destination", () => {
  let mock: MockMcp | undefined;
  afterEach(async () => {
    await mock?.stop();
    mock = undefined;
  });

  const withServer = (url: string) =>
    configSchema.parse({
      me,
      mcp: [{ name: "notes", url }],
      exports: [
        {
          name: "note",
          type: "text",
          line: "{project}",
          to: {
            mcp: "notes",
            tool: "write_note",
            arguments: { title: "Worklog {date}", content: "{text}" },
          },
        },
      ],
    });

  it("calls the tool with the text and the day filled in", async () => {
    mock = await startMockMcp({ open: true });
    const c = withServer(mock.url);
    const said = await capture(() =>
      saveToDestination(c, destinationExport(c, "note"), "Fix auth", "2026-10-16", { yes: true }),
    );
    expect(said).toContain("note → notes · write_note (title, content)");
    expect(said).toContain("Called write_note on notes.");
    expect(mock.notes).toEqual([{ title: "Worklog 2026-10-16", content: "Fix auth" }]);
  });

  it("names the tools the server has when the tool isn't one of them", async () => {
    mock = await startMockMcp({ open: true });
    const c = configSchema.parse({
      me,
      mcp: [{ name: "notes", url: mock.url }],
      exports: [
        { name: "note", type: "text", line: "{project}", to: { mcp: "notes", tool: "add_page" } },
      ],
    });
    await expect(
      saveToDestination(c, destinationExport(c, "note"), "Fix auth", "2026-10-16", { yes: true }),
    ).rejects.toThrow(
      'notes has no tool called "add_page". It offers: list_meetings, get_meeting, write_note, always_fails.',
    );
  });

  it("says the tool's own error, with where it was going", async () => {
    mock = await startMockMcp({ open: true });
    const c = configSchema.parse({
      me,
      mcp: [{ name: "notes", url: mock.url }],
      exports: [
        {
          name: "note",
          type: "text",
          line: "{project}",
          to: { mcp: "notes", tool: "always_fails" },
        },
      ],
    });
    await expect(
      saveToDestination(c, destinationExport(c, "note"), "Fix auth", "2026-10-16", { yes: true }),
    ).rejects.toThrow("Couldn't write to notes · always_fails: notes: The notes service is down");
  });

  it("says how to connect a server the config doesn't have", async () => {
    mock = await startMockMcp({ open: true });
    const c = withServer(mock.url);
    const plan = await planDestination({ mcp: "notion", tool: "append_block" }, "x", {
      date: "2026-10-16",
    });
    const { config: other } = { config: { ...c, mcp: [] } };
    await expect(
      writeDestination({ mcp: "notion", tool: "append_block" }, plan, { config: other }),
    ).rejects.toThrow(
      'There\'s no MCP server called "notion" in your config. Run `clockout connect notion',
    );
  });
});

describe("which export to send", () => {
  it("takes the one with a destination, or the default among them", () => {
    const c = config([
      { name: "plain", type: "csv" },
      { name: "daily", type: "markdown", to: { file: "~/Vault/{date}.md" } },
      { name: "log", type: "text", line: "{project}", to: { file: "~/log.md", append: true } },
    ]);
    expect(() => destinationExport(c)).toThrow("Which export? daily, log each have a destination");
    expect(destinationExport(c, "log").name).toBe("log");
    const one = config([{ name: "daily", type: "markdown", to: { file: "~/Vault/{date}.md" } }]);
    expect(destinationExport(one).name).toBe("daily");
    const marked = config([
      { name: "daily", type: "markdown", to: { file: "~/Vault/{date}.md" }, default: true },
      { name: "log", type: "text", line: "{project}", to: { file: "~/log.md" } },
    ]);
    expect(destinationExport(marked).name).toBe("daily");
  });

  it("says what to add when no export has one", () => {
    const c = config([{ name: "plain", type: "csv" }]);
    expect(() => destinationExport(c)).toThrow("No export has a destination yet");
    expect(() => destinationExport(c, "csv")).toThrow("csv is built in and has no destination");
    expect(() => destinationExport(c, "plain")).toThrow("plain has no destination");
  });
});

describe("settings the chat bar can change", () => {
  const base = config([
    { name: "daily", type: "markdown", to: { file: "~/Vault/Daily/{date}.md", append: true } },
  ]);

  it("can say an MCP tool, which the AI may propose", () => {
    const r = applySettings(base, [
      {
        op: "export_format",
        name: "notion",
        type: "text",
        line: "{project}",
        to: { mcp: "notion", tool: "append_block", arguments: { content: "{text}" } },
      },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.config.exports.find((e) => e.name === "notion")?.to).toEqual({
      mcp: "notion",
      tool: "append_block",
      arguments: { content: "{text}" },
    });
  });

  it("keeps the file a format already writes to, since a path is set by hand", () => {
    const r = applySettings(base, [
      { op: "export_format", name: "daily", type: "markdown", default: true },
    ]);
    expect(r.errors).toEqual([]);
    expect(r.config.exports[0]?.to).toEqual({
      file: "~/Vault/Daily/{date}.md",
      append: true,
    });
  });

  it("isn't in what the AI is told", () => {
    const seen = settingsContext(base, {
      googleConnected: false,
      claudeProjects: [],
    });
    expect(JSON.stringify(seen.exports)).not.toContain("Vault");
  });
});
