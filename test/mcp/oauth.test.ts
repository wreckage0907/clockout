import { afterEach, describe, expect, it } from "vitest";
import type { McpCredentials } from "../../src/config/credentials";
import { mcpClient } from "../../src/mcp/client";
import { connectMcp, discoverMcpAuth, mcpAuth, revokeMcp } from "../../src/mcp/oauth";
import { type MockMcp, type MockMcpOptions, startMockMcp } from "../mock-mcp/server";

let mock: MockMcp | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

async function start(opts: MockMcpOptions = {}) {
  mock = await startMockMcp(opts);
  return mock;
}

/** Stands in for the browser: open the sign-in page and follow its redirect back to Clockout. */
let opened = "";
const browser = async (url: string) => {
  opened = url;
  await fetch(url);
};

describe("MCP sign-in", () => {
  it("follows the 401 to the resource's metadata and its authorization server", async () => {
    const m = await start();
    const plan = await discoverMcpAuth("wispr", m.url);
    expect(plan).toMatchObject({
      resource: m.url,
      scope: "meetings notes",
      server: { token_endpoint: `${m.origin}/auth/token` },
    });
    expect(m.requests.map((r) => r.path)).toEqual([
      "/mcp",
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/auth",
    ]);
  });

  it("registers, signs in with PKCE for this server only, and gets tokens", async () => {
    const m = await start();
    const creds = await connectMcp("wispr", m.url, browser);
    const q = new URL(opened).searchParams;
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("resource")).toBe(m.url);
    expect(q.get("scope")).toBe("meetings notes");
    expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(creds).toMatchObject({
      url: m.url,
      resource: m.url,
      token_endpoint: `${m.origin}/auth/token`,
      revocation_endpoint: `${m.origin}/auth/revoke`,
      client_id: expect.stringMatching(/^client-/),
      access_token: expect.stringMatching(/^at-/),
      refresh_token: expect.stringMatching(/^rt-/),
    });
    const register = JSON.parse(m.requests.find((r) => r.path === "/auth/register")?.body ?? "");
    expect(register).toMatchObject({ client_name: "Clockout", token_endpoint_auth_method: "none" });
  });

  it("needs no sign-in for a server that answers anyone", async () => {
    const m = await start({ open: true });
    expect(await connectMcp("notes", m.url, browser)).toBeNull();
  });

  it("stops when access isn't allowed", async () => {
    const m = await start({ deny: true });
    await expect(connectMcp("wispr", m.url, browser)).rejects.toThrow(
      "Access wasn't allowed, so nothing was connected.",
    );
  });

  it("won't use metadata that's about another server", async () => {
    const m = await start();
    const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("oauth-protected-resource"))
        return Response.json({
          resource: "https://evil.example/mcp",
          authorization_servers: [`${m.origin}/auth`],
        });
      return fetch(input, init);
    }) as typeof fetch;
    await expect(discoverMcpAuth("wispr", m.url, doFetch)).rejects.toThrow(
      "wispr's sign-in metadata is for a different server (https://evil.example/mcp).",
    );
  });

  it("won't sign in through an authorization server that isn't https", async () => {
    const m = await start();
    const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).includes("oauth-protected-resource"))
        return Response.json({
          resource: m.url,
          authorization_servers: ["http://auth.example.com"],
        });
      return fetch(input, init);
    }) as typeof fetch;
    await expect(discoverMcpAuth("wispr", m.url, doFetch)).rejects.toThrow(
      "wispr signs in through http://auth.example.com, which isn't https.",
    );
  });
});

describe("signed-in calls", () => {
  async function signedIn(opts: MockMcpOptions = {}) {
    const m = await start(opts);
    const creds = (await connectMcp("wispr", m.url, browser)) as McpCredentials;
    const saved: McpCredentials[] = [];
    const token = mcpAuth("wispr", creds, async (next) => {
      saved.push(next);
    });
    return { m, creds, saved, client: mcpClient({ url: m.url, name: "wispr", token }) };
  }

  it("uses the saved access token while it lasts", async () => {
    const { m, creds, saved, client } = await signedIn();
    const before = m.requests.length;
    await client.listTools();
    expect(saved).toEqual([]);
    const auths = m.requests.slice(before).map((r) => r.auth);
    expect(new Set(auths)).toEqual(new Set([`Bearer ${creds.access_token}`]));
  });

  it("refreshes after a 401 and keeps the rotated refresh token", async () => {
    const { m, creds, saved, client } = await signedIn();
    m.expireTokens();
    expect(await client.callTool("get_meeting", { id: "rec-1" })).toMatchObject({ id: "rec-1" });
    expect(saved).toHaveLength(1);
    expect(saved[0]?.refresh_token).not.toBe(creds.refresh_token);
    const refresh = new URLSearchParams(
      m.requests.filter((r) => r.path === "/auth/token").at(-1)?.body,
    );
    expect(refresh.get("grant_type")).toBe("refresh_token");
    expect(refresh.get("resource")).toBe(m.url);
  });

  it("refreshes before a call when the token has run out, then reuses the new one", async () => {
    const m = await start({ tokenLife: 30 });
    const creds = (await connectMcp("wispr", m.url, browser)) as McpCredentials;
    // A 30-second token is used for 15 seconds, so short-lived tokens aren't refreshed every call.
    const until = Date.parse(creds.expires_at ?? "") - Date.now();
    expect(until).toBeGreaterThan(10_000);
    expect(until).toBeLessThanOrEqual(15_000);
    const saved: McpCredentials[] = [];
    const token = mcpAuth(
      "wispr",
      { ...creds, expires_at: new Date(Date.now() - 1000).toISOString() },
      async (next) => {
        saved.push(next);
      },
    );
    const before = m.requests.length;
    await mcpClient({ url: m.url, name: "wispr", token }).listTools();
    expect(saved).toHaveLength(1);
    const used = m.requests.slice(before).filter((r) => r.path === "/mcp");
    expect(new Set(used.map((r) => r.auth))).toEqual(new Set([`Bearer ${saved[0]?.access_token}`]));
  });

  it("asks you to connect again when the refresh token was revoked", async () => {
    const { m, creds } = await signedIn();
    await revokeMcp(creds);
    expect(m.revoked).toEqual([creds.refresh_token]);
    m.expireTokens();
    const token = mcpAuth("wispr", creds, async () => undefined);
    await expect(token(true)).rejects.toThrow(
      "The sign-in to wispr expired or was revoked. Run `clockout connect wispr` again.",
    );
  });

  it("without a refresh token, an expired sign-in asks you to connect again", async () => {
    const token = mcpAuth(
      "wispr",
      {
        url: "https://x.example/mcp",
        resource: "https://x.example/mcp",
        token_endpoint: "https://x.example/token",
        client_id: "c",
        access_token: "old",
        expires_at: "2020-01-01T00:00:00Z",
        connected_at: "2020-01-01T00:00:00Z",
      },
      async () => undefined,
    );
    await expect(token()).rejects.toThrow("The sign-in to wispr has expired.");
  });
});
