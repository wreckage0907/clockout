import { createHash } from "node:crypto";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  loadGoogleCredentials,
  removeGoogleCredentials,
  saveGoogleCredentials,
} from "../../src/config/credentials";
import { configSchema } from "../../src/config/schema";
import {
  accessToken,
  authUrl,
  connectGoogle,
  GOOGLE_SCOPE,
  googleClient,
  pkcePair,
  revoke,
} from "../../src/sources/google-calendar/oauth";

const client = { client_id: "cid.apps.googleusercontent.com", client_secret: "secret" };

describe("Google sign-in", () => {
  it("asks only for read-only events, offline access and PKCE", () => {
    const url = new URL(authUrl(client, "http://127.0.0.1:5555", "chal", "st"));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      scope: GOOGLE_SCOPE,
      access_type: "offline",
      code_challenge: "chal",
      code_challenge_method: "S256",
      redirect_uri: "http://127.0.0.1:5555",
      state: "st",
    });
    expect(GOOGLE_SCOPE).toBe("https://www.googleapis.com/auth/calendar.events.readonly");
  });

  it("makes an S256 PKCE pair", () => {
    const { verifier, challenge } = pkcePair();
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("runs the loopback flow and returns a refresh token", async () => {
    let tokenBody = "";
    const doFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      tokenBody = String(init?.body);
      return Response.json({
        access_token: "at",
        expires_in: 3600,
        refresh_token: "rt",
        scope: GOOGLE_SCOPE,
      });
    }) as typeof fetch;
    // Stand in for the browser: follow the consent screen straight back to the redirect URI.
    const open = async (url: string) => {
      const q = new URL(url).searchParams;
      await fetch(`${q.get("redirect_uri")}/?code=abc&state=${q.get("state")}`);
    };
    const result = await connectGoogle(client, open, { fetch: doFetch });
    expect(result).toEqual({ refreshToken: "rt", scope: GOOGLE_SCOPE });
    const sent = new URLSearchParams(tokenBody);
    expect(sent.get("code")).toBe("abc");
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code_verifier")).toBeTruthy();
  });

  it("ignores a callback with the wrong state, and explains a declined consent", async () => {
    // A forged callback doesn't cancel the sign-in; the real one that follows still works.
    const sent: string[] = [];
    const doFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      sent.push(String(init?.body));
      return Response.json({ access_token: "at", expires_in: 3600, refresh_token: "rt" });
    }) as typeof fetch;
    const forgedThenReal = async (url: string) => {
      const q = new URL(url).searchParams;
      const back = q.get("redirect_uri");
      expect((await fetch(`${back}/?code=evil&state=forged`)).status).toBe(400);
      expect((await fetch(`${back}/?error=access_denied`)).status).toBe(400);
      await fetch(`${back}/?code=abc&state=${q.get("state")}`);
    };
    await expect(connectGoogle(client, forgedThenReal, { fetch: doFetch })).resolves.toMatchObject({
      refreshToken: "rt",
    });
    expect(new URLSearchParams(sent[0]).get("code")).toBe("abc");
    const denied = async (url: string) => {
      const q = new URL(url).searchParams;
      await fetch(`${q.get("redirect_uri")}/?error=access_denied&state=${q.get("state")}`);
    };
    await expect(connectGoogle(client, denied)).rejects.toThrow("access wasn't allowed");
  });

  it("says to reconnect when the refresh token is revoked", async () => {
    const doFetch = (async () =>
      Response.json({ error: "invalid_grant" }, { status: 400 })) as typeof fetch;
    await expect(accessToken(client, "rt", doFetch)).rejects.toThrow(
      "Run `clockout connect google` again",
    );
  });

  it("never follows a redirect on token, refresh and revoke requests, and times out", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const doFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return Response.json({ access_token: "at", expires_in: 3600 });
    }) as typeof fetch;
    await accessToken(client, "rt", doFetch);
    await revoke("rt-secret", doFetch);
    expect(seen).toHaveLength(2);
    for (const { init } of seen) {
      expect(init.redirect).toBe("error");
      expect(init.signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("says Google didn't answer when the request times out", async () => {
    const doFetch = (async () => {
      throw new DOMException("timed out", "TimeoutError");
    }) as typeof fetch;
    await expect(accessToken(client, "rt", doFetch)).rejects.toThrow(
      "Google didn't answer within 30 seconds",
    );
  });

  it("sends the refresh token to revoke in the body, not the address", async () => {
    let url = "";
    let init: RequestInit = {};
    const doFetch = (async (u: string | URL | Request, i?: RequestInit) => {
      url = String(u);
      init = i ?? {};
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await revoke("rt-secret", doFetch);
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(url).not.toContain("rt-secret");
    expect(new URLSearchParams(String(init.body)).get("token")).toBe("rt-secret");
    expect(init.method).toBe("POST");
  });

  it("uses your own client from config or env, and explains when none is set", () => {
    const config = configSchema.parse({
      me: { name: "D", emails: ["d@example.com"], timezone: "UTC" },
      google: { client_id: "mine", client_secret: "s" },
    });
    expect(googleClient(config, {}).client_id).toBe("mine");
    expect(
      googleClient(null, { CLOCKOUT_GOOGLE_CLIENT_ID: "env", CLOCKOUT_GOOGLE_CLIENT_SECRET: "s" })
        .client_id,
    ).toBe("env");
    expect(() => googleClient(null, {})).toThrow("docs/google-setup.md");
  });
});

describe("credentials file", () => {
  it("stores the sign-in readable only by you, and forgets it", async () => {
    const path = join(await mkdtemp(join(tmpdir(), "clockout-creds-")), "credentials.json");
    const creds = {
      refresh_token: "rt",
      client_id: "cid",
      scope: GOOGLE_SCOPE,
      connected_at: "now",
    };
    await saveGoogleCredentials(creds, path);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadGoogleCredentials(path)).toEqual(creds);
    await removeGoogleCredentials(path);
    expect(await loadGoogleCredentials(path)).toBeNull();
  });
});
