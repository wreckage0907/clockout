import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import type { ErpCredentials } from "../../src/config/credentials";
import { connectErp, erpAuth } from "../../src/targets/next-pms/oauth";

const metadata = JSON.parse(
  await readFile(new URL("../fixtures/next-pms/oauth-metadata.json", import.meta.url), "utf8"),
) as Record<string, string>;

interface Call {
  url: string;
  body: string;
}

/** The ERP's OAuth endpoints in memory. */
function server(opts: { registration?: number; rotate?: boolean; grant?: "invalid" } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, body: String(init?.body ?? "") });
    if (url.endsWith("/.well-known/oauth-authorization-server")) return Response.json(metadata);
    if (url === metadata.registration_endpoint) {
      if (opts.registration === 404) return new Response("Not Found", { status: 404 });
      return Response.json({ client_id: "cid-1", grant_types: ["authorization_code"] });
    }
    if (url === metadata.token_endpoint) {
      if (opts.grant === "invalid")
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      n++;
      return Response.json({
        access_token: `at-${n}`,
        expires_in: 3600,
        token_type: "Bearer",
        refresh_token: opts.rotate === false ? "rt-0" : `rt-${n}`,
      });
    }
    if (url.endsWith("frappe.auth.get_logged_user"))
      return Response.json({ message: "dev@example.com" });
    return new Response("?", { status: 500 });
  }) as typeof fetch;
  return { calls, doFetch };
}

/** Stands in for the browser: approve, and follow the redirect back to Clockout. */
const approve = async (url: string) => {
  const q = new URL(url).searchParams;
  await fetch(`${q.get("redirect_uri")}?code=the-code&state=${q.get("state")}`);
};

describe("ERP sign-in", () => {
  it("registers a public client for its loopback address, then trades the code with PKCE", async () => {
    const { calls, doFetch } = server();
    let opened = "";
    const result = await connectErp(
      "https://erp.example.com/app/timesheet",
      async (url) => {
        opened = url;
        await approve(url);
      },
      { fetch: doFetch },
    );
    expect(result).toEqual({
      url: "https://erp.example.com",
      clientId: "cid-1",
      refreshToken: "rt-1",
      user: "dev@example.com",
    });

    const registration = JSON.parse(
      (calls.find((c) => c.url === metadata.registration_endpoint) as Call).body,
    );
    expect(registration).toMatchObject({
      client_name: "Clockout",
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
    });
    const redirect = registration.redirect_uris[0] as string;
    expect(redirect).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);

    const auth = new URL(opened);
    expect(auth.origin + auth.pathname).toBe(metadata.authorization_endpoint);
    expect(Object.fromEntries(auth.searchParams)).toMatchObject({
      client_id: "cid-1",
      redirect_uri: redirect,
      response_type: "code",
      code_challenge_method: "S256",
    });

    const token = new URLSearchParams(
      (calls.find((c) => c.url === metadata.token_endpoint) as Call).body,
    );
    expect(token.get("grant_type")).toBe("authorization_code");
    expect(token.get("code")).toBe("the-code");
    expect(token.get("redirect_uri")).toBe(redirect);
    expect(token.get("code_verifier")?.length).toBeGreaterThan(40);
  });

  it("explains when the ERP doesn't let apps register", async () => {
    const { doFetch } = server({ registration: 404 });
    await expect(
      connectErp("https://erp.example.com", approve, { fetch: doFetch }),
    ).rejects.toThrow("Enable Dynamic Client Registration");
  });
});

describe("erpAuth", () => {
  const creds: ErpCredentials = {
    url: "https://erp.example.com",
    client_id: "cid-1",
    refresh_token: "rt-0",
    connected_at: "2026-10-21T00:00:00Z",
  };

  it("refreshes once, reuses the token, and saves the rotated refresh token", async () => {
    const { calls, doFetch } = server();
    const saved: ErpCredentials[] = [];
    const auth = erpAuth(creds, async (c) => void saved.push(c), doFetch);
    const [a, b] = await Promise.all([auth.token(), auth.token()]);
    expect([a, b, await auth.token()]).toEqual(["at-1", "at-1", "at-1"]);
    expect(saved).toEqual([{ ...creds, refresh_token: "rt-1" }]);
    expect(await auth.token(true)).toBe("at-2");
    const second = new URLSearchParams(
      calls.filter((c) => c.url === metadata.token_endpoint)[1]?.body,
    );
    expect(second.get("refresh_token")).toBe("rt-1");
    expect(second.get("client_id")).toBe("cid-1");
  });

  it("asks you to connect again when the sign-in was revoked", async () => {
    const { doFetch } = server({ grant: "invalid" });
    await expect(erpAuth(creds, async () => {}, doFetch).token()).rejects.toThrow(
      "clockout connect erp",
    );
  });
});
