import { describe, expect, it, vi } from "vitest";
import { mcpClient } from "../../src/mcp/client";
import { revokeMcp } from "../../src/mcp/oauth";
import { registerPublicClient, tokenRequest } from "../../src/oauth";

// A resolver that sends every name to a remote address: what glibc without nss-myhostname can do
// to `something.localhost`. Nothing secret may go to it over plain http.
vi.mock("node:dns/promises", () => ({
  lookup: async () => [{ address: "203.0.113.7", family: 4 }],
}));

const never = vi.fn(async () => new Response("{}"));
const doFetch = never as unknown as typeof fetch;

describe("secrets over plain http to a name that resolves elsewhere", () => {
  const url = "http://erp.localhost:8000/mcp";

  it("aren't sent with an MCP token", async () => {
    const c = mcpClient({ url, name: "erp", token: async () => "secret-at", fetch: doFetch });
    await expect(c.initialize()).rejects.toThrow("erp.localhost doesn't resolve to this machine");
    expect(never).not.toHaveBeenCalled();
  });

  it("aren't sent to a token or registration endpoint", async () => {
    await expect(tokenRequest(url, { refresh_token: "secret-rt" }, doFetch)).rejects.toThrow(
      "doesn't resolve to this machine",
    );
    await expect(registerPublicClient(url, "http://127.0.0.1:1", doFetch)).rejects.toThrow(
      "doesn't resolve to this machine",
    );
    expect(never).not.toHaveBeenCalled();
  });

  it("aren't sent to revoke (best effort, so quietly)", async () => {
    await revokeMcp(
      {
        url,
        resource: url,
        token_endpoint: url,
        revocation_endpoint: "http://erp.localhost:8000/revoke",
        client_id: "c",
        access_token: "at",
        refresh_token: "secret-rt",
        connected_at: "2026-10-16T00:00:00Z",
      },
      doFetch,
    );
    expect(never).not.toHaveBeenCalled();
  });

  it("still go over https", async () => {
    await tokenRequest("https://as.example/token", { refresh_token: "rt" }, doFetch);
    expect(never).toHaveBeenCalledOnce();
  });
});
