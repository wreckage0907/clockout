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
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clockout-dest-"));
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
      erpConnected: false,
      claudeProjects: [],
    });
    expect(JSON.stringify(seen.exports)).not.toContain("Vault");
  });
});
