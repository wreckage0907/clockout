import { chmod, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadGoogleCredentials,
  loadMcpCredentials,
  type McpCredentials,
  removeMcpCredentials,
  saveGoogleCredentials,
  saveMcpCredentials,
  withMcpCredentials,
} from "../../src/config/credentials";

let dir: string;
let path: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clockout-creds-"));
  path = join(dir, "credentials.json");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const mcp = (n: number): McpCredentials => ({
  url: `https://m${n}.example/mcp`,
  resource: `https://m${n}.example/mcp`,
  token_endpoint: `https://m${n}.example/token`,
  client_id: `c${n}`,
  refresh_token: `rt-${n}`,
  access_token: `at-${n}`,
  connected_at: "2026-10-26T00:00:00Z",
});
const google = {
  refresh_token: "g-rt",
  client_id: "g-client",
  scope: "s",
  connected_at: "2026-10-26T00:00:00Z",
};

describe("credentials file", () => {
  it("keeps every writer's change when saves overlap", async () => {
    // Each save reads, changes and writes; unguarded, the later write undoes the earlier ones.
    await Promise.all([
      ...Array.from({ length: 10 }, (_, n) => saveMcpCredentials(`s${n}`, mcp(n), path)),
      saveGoogleCredentials(google, path),
    ]);
    for (let n = 0; n < 10; n++)
      expect((await loadMcpCredentials(`s${n}`, path))?.refresh_token).toBe(`rt-${n}`);
    expect(await loadGoogleCredentials(path)).toMatchObject({ refresh_token: "g-rt" });
    expect(await readdir(dir)).toEqual(["credentials.json"]); // no lock or scratch files left
  });

  it("a removal doesn't bring back or lose its neighbours", async () => {
    await saveMcpCredentials("a", mcp(1), path);
    await saveMcpCredentials("b", mcp(2), path);
    await Promise.all([removeMcpCredentials("a", path), saveGoogleCredentials(google, path)]);
    expect(await loadMcpCredentials("a", path)).toBeNull();
    expect(await loadMcpCredentials("b", path)).not.toBeNull();
    expect(await loadGoogleCredentials(path)).not.toBeNull();
  });

  it("readers never see a half-written file while it's being rewritten", async () => {
    await saveMcpCredentials("a", mcp(1), path);
    let writing = true;
    const writer = (async () => {
      for (let n = 0; n < 40; n++) await saveMcpCredentials("b", mcp(n), path);
      writing = false;
    })();
    let reads = 0;
    while (writing) {
      // Throws if it ever catches the file truncated or empty.
      expect((await loadMcpCredentials("a", path))?.refresh_token).toBe("rt-1");
      reads++;
    }
    await writer;
    expect(reads).toBeGreaterThan(0);
  });

  it("is readable only by you, even when the file was wider before", async () => {
    await writeFile(path, "{}\n", { mode: 0o644 });
    await chmod(path, 0o644);
    await saveMcpCredentials("a", mcp(1), path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("returns null for a file that isn't there, and doesn't create one by reading", async () => {
    expect(await loadMcpCredentials("a", path)).toBeNull();
    expect(await readdir(dir)).toEqual([]);
  });

  it("removes the file when the last sign-in goes", async () => {
    await saveMcpCredentials("a", mcp(1), path);
    await removeMcpCredentials("a", path);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("a file that can't be read", () => {
  it("says what's wrong and never overwrites it", async () => {
    const broken = '{"mcp": {"a": {"refresh_token": "precious"';
    await writeFile(path, broken);
    await expect(loadMcpCredentials("a", path)).rejects.toThrow(
      /Can't read your saved sign-ins in .*credentials\.json: it isn't valid JSON\. Nothing was changed\. Fix the file, or delete it/,
    );
    await expect(saveMcpCredentials("b", mcp(2), path)).rejects.toThrow("Nothing was changed");
    await expect(saveGoogleCredentials(google, path)).rejects.toThrow("Nothing was changed");
    await expect(removeMcpCredentials("b", path)).rejects.toThrow("Nothing was changed");
    expect(await readFile(path, "utf8")).toBe(broken);
    expect(await readdir(dir)).toEqual(["credentials.json"]);
  });

  it("refuses JSON that isn't an object", async () => {
    await writeFile(path, "[1]");
    await expect(loadGoogleCredentials(path)).rejects.toThrow("it isn't a JSON object");
    expect(await readFile(path, "utf8")).toBe("[1]");
  });

  it("one entry that doesn't fit doesn't hide or discard the others", async () => {
    const bad = { refresh_token: 42 };
    await writeFile(
      path,
      JSON.stringify({ google: bad, mcp: { a: mcp(1), broken: { nope: true } } }),
    );
    expect(await loadGoogleCredentials(path)).toBeNull();
    expect(await loadMcpCredentials("broken", path)).toBeNull();
    expect(await loadMcpCredentials("a", path)).toMatchObject({ refresh_token: "rt-1" });
    await saveMcpCredentials("c", mcp(3), path);
    const saved = JSON.parse(await readFile(path, "utf8"));
    expect(saved.google).toEqual(bad); // kept as it was, not silently dropped
    expect(saved.mcp.broken).toEqual({ nope: true });
    expect(Object.keys(saved.mcp)).toEqual(expect.arrayContaining(["a", "broken", "c"]));
  });
});

describe("withMcpCredentials", () => {
  it("shows what's saved now and saves without anyone writing in between", async () => {
    await saveMcpCredentials("a", mcp(1), path);
    let other: Promise<void> | undefined;
    await withMcpCredentials(
      "a",
      async (stored, save) => {
        expect(stored?.refresh_token).toBe("rt-1");
        // Another writer arrives while we hold the lock; it waits for us.
        other = saveGoogleCredentials(google, path);
        await save({ ...mcp(1), refresh_token: "rt-rotated" });
        expect(await loadGoogleCredentials(path)).toBeNull();
      },
      path,
    );
    await other;
    expect((await loadMcpCredentials("a", path))?.refresh_token).toBe("rt-rotated");
    expect(await loadGoogleCredentials(path)).not.toBeNull();
  });

  it("gives null for a sign-in that isn't saved", async () => {
    await withMcpCredentials("a", async (stored) => expect(stored).toBeNull(), path);
  });
});
