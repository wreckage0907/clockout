import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadGoogleCredentials,
  loadMcpCredentials,
  saveMcpCredentials,
} from "../../src/config/credentials";

// Before the next-pms target was removed, credentials.json could hold an `erp` sign-in.

describe("an old erp sign-in in credentials.json", () => {
  it("is ignored, and left out when the file is written next", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clockout-creds-"));
    const path = join(dir, "credentials.json");
    await writeFile(
      path,
      JSON.stringify({
        erp: {
          url: "https://erp.example.com",
          client_id: "abc",
          refresh_token: "old-refresh-token",
          connected_at: "2026-10-01T00:00:00Z",
        },
        google: {
          refresh_token: "g-token",
          client_id: "id",
          scope: "calendar.readonly",
          connected_at: "2026-10-01T00:00:00Z",
        },
      }),
    );
    expect((await loadGoogleCredentials(path))?.refresh_token).toBe("g-token");
    expect(await loadMcpCredentials("wispr", path)).toBeNull();

    await saveMcpCredentials(
      "wispr",
      {
        url: "https://mcp.example.com",
        resource: "https://mcp.example.com",
        token_endpoint: "https://mcp.example.com/token",
        client_id: "c",
        access_token: "t",
        connected_at: "2026-10-02T00:00:00Z",
      },
      path,
    );
    const text = await readFile(path, "utf8");
    expect(text).not.toContain("old-refresh-token");
    expect(JSON.parse(text)).toHaveProperty("google");
  });
});
