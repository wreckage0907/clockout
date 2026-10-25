import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type MockMcp, startMockMcp } from "../mock-mcp/server";
import { type Sandbox, sandbox } from "./helpers";

// `clockout connect <name>` against the mock MCP server (test/mock-mcp): the CLI prints the
// sign-in address (there's no browser on its PATH), the test opens it the way a browser would,
// the mock approves and redirects back to Clockout's loopback listener.

const CONFIG = `[me]
name = "Dev"
emails = ["dev@example.com"]
timezone = "Asia/Kolkata"

[ai]
backend = "none"
`;

/** Opens the printed sign-in address and follows its redirect back to the running CLI. */
async function signIn(sb: Sandbox, args: string[]) {
  const run = sb.start(args);
  const [, url] = await run.waitFor(/visit:\n\n {2}(\S+)\n/);
  const page = await fetch(url as string);
  return { run, page, url: url as string };
}

const credentials = async (sb: Sandbox) =>
  JSON.parse(await readFile(join(sb.config, "credentials.json"), "utf8")) as {
    mcp?: Record<string, Record<string, string>>;
  };

describe("connecting an MCP server", () => {
  let mock: MockMcp;
  let sb: Sandbox;
  beforeAll(async () => {
    mock = await startMockMcp();
    sb = await sandbox();
    await sb.writeConfig(CONFIG);
  });
  afterAll(() => mock.stop());

  it("signs in through the browser, lists the server's tools and adds it to [[mcp]]", async () => {
    const { run, page, url } = await signIn(sb, ["connect", "meetings", mock.url]);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Clockout is connected to meetings.");
    expect(new URL(url).searchParams.get("resource")).toBe(mock.url);

    const r = await run.done;
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Clockout signs in to 127.0.0.1:");
    expect(r.stdout).toContain(
      "Connected to meetings (Mock Meetings). It offers 4 tools: list_meetings, get_meeting, write_note, always_fails.",
    );
    expect(r.stdout).toContain("The sign-in is kept in ~/.config/clockout/credentials.json");

    const config = await readFile(join(sb.config, "config.toml"), "utf8");
    expect(config).toContain(`[[mcp]]\nname = "meetings"\nurl = "${mock.url}"`);
    const creds = await credentials(sb);
    const saved = creds.mcp?.meetings;
    expect(saved).toMatchObject({ url: mock.url, resource: mock.url });
    expect(saved?.refresh_token).toMatch(/^rt-/);
    // Tokens stay in the file, readable only by you, and never reach the terminal.
    expect((await stat(join(sb.config, "credentials.json"))).mode & 0o777).toBe(0o600);
    expect(r.stdout).not.toContain(saved?.access_token);
    expect(r.stdout).not.toContain(saved?.refresh_token);
  });

  it("connects again by name alone, from the config", async () => {
    const before = (await credentials(sb)).mcp?.meetings?.refresh_token;
    const { run } = await signIn(sb, ["connect", "meetings"]);
    const r = await run.done;
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Connected to meetings (Mock Meetings).");
    expect((await credentials(sb)).mcp?.meetings?.refresh_token).not.toBe(before);
    const config = await readFile(join(sb.config, "config.toml"), "utf8");
    expect(config.match(/\[\[mcp\]\]/g)).toHaveLength(1);
  });

  it("disconnects: revokes the sign-in and forgets it, keeping the server in the config", async () => {
    const token = (await credentials(sb)).mcp?.meetings?.refresh_token;
    const r = await sb.run(["disconnect", "meetings"]);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(
      "Disconnected from meetings. It stays in your config's [[mcp]] list until you remove it.\n",
    );
    expect(mock.revoked).toContain(token);
    await expect(readFile(join(sb.config, "credentials.json"), "utf8")).rejects.toThrow();
    expect(await readFile(join(sb.config, "config.toml"), "utf8")).toContain('name = "meetings"');

    const again = await sb.run(["disconnect", "meetings"]);
    expect(again.code).toBe(0);
    expect(again.stdout).toBe("meetings wasn't connected.\n");
  });
});

describe("connecting an MCP server, when it can't", () => {
  it("says access wasn't allowed when you turn it down, and saves nothing", async () => {
    const mock = await startMockMcp({ deny: true });
    const sb = await sandbox();
    await sb.writeConfig(CONFIG);
    const { run, page } = await signIn(sb, ["connect", "meetings", mock.url]);
    expect(await page.text()).toContain("Sign-in didn't finish.");
    const r = await run.done;
    await mock.stop();
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("clockout: Access wasn't allowed, so nothing was connected.\n");
    expect(await readFile(join(sb.config, "config.toml"), "utf8")).not.toContain("[[mcp]]");
    await expect(readFile(join(sb.config, "credentials.json"), "utf8")).rejects.toThrow();
  });

  it("connects a server that needs no sign-in without opening a browser", async () => {
    const mock = await startMockMcp({ open: true });
    const sb = await sandbox();
    await sb.writeConfig(CONFIG);
    const r = await sb.run(["connect", "notes", mock.url]);
    await mock.stop();
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("visit:");
    expect(r.stdout).toContain("Connected to notes (Mock Meetings). It offers 4 tools");
    expect(r.stdout).toContain("It didn't ask for a sign-in.");
  });

  it("asks for an address for a name it doesn't know", async () => {
    const sb = await sandbox();
    await sb.writeConfig(CONFIG);
    const r = await sb.run(["connect", "wispr"]);
    expect(r.stdout).toBe("");
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      'clockout: There\'s no MCP server called "wispr" in your config. Give its address: clockout connect wispr https://example.com/mcp\n',
    );
  });

  it("refuses plain http to another machine before signing in", async () => {
    const sb = await sandbox();
    await sb.writeConfig(CONFIG);
    const r = await sb.run(["connect", "notes", "http://notes.example.com/mcp"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toBe(
      "clockout: notes: use https:// (plain http only works for a server on this machine).\n",
    );
  });

  it("refuses a name that isn't one", async () => {
    const sb = await sandbox();
    const r = await sb.run(["connect", "My Server"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('Connect "google" (your calendar), "erp"');
  });

  it("says where nothing answers", async () => {
    const sb = await sandbox();
    await sb.writeConfig(CONFIG);
    const r = await sb.run(["connect", "notes", "http://127.0.0.1:9/mcp"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain(
      "clockout: Couldn't reach notes at 127.0.0.1:9. Check your connection.",
    );
  });
});
