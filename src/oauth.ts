import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";

// The browser half of an OAuth sign-in from a CLI (RFC 8252): a one-shot listener on
// 127.0.0.1 that catches the redirect, with PKCE so the code is useless to anyone else.

export type Fetch = typeof fetch;

const serverMetadata = z.object({
  issuer: z.string().optional(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  revocation_endpoint: z.string().optional(),
  code_challenge_methods_supported: z.array(z.string()).optional(),
});
/** Where an authorization server signs you in (RFC 8414). */
export type AuthServer = z.infer<typeof serverMetadata>;

/** How long a sign-in request may take before Clockout gives up on the server. */
export const OAUTH_TIMEOUT_MS = 30_000;

/**
 * Options for a request that carries a secret (a code, a refresh token): a redirect is never
 * followed (Node would re-send the body to wherever it points) and it can't hang for ever.
 */
export function secretRequest(): { redirect: "error"; signal: AbortSignal } {
  return { redirect: "error", signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS) };
}

/** Whether a failed request was stopped by the timeout. */
export function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
}

/** What went wrong reaching a sign-in server, in words; the cause goes to the error log. */
export function reachError(url: string, err: unknown): Error {
  const host = URL.canParse(url) ? new URL(url).host : "the sign-in server";
  if (isTimeout(err))
    return new Error(
      `The sign-in server at ${host} didn't answer within ${OAUTH_TIMEOUT_MS / 1000} seconds. Try again later.`,
      { cause: err },
    );
  const cause = err instanceof Error ? err.cause : undefined;
  if (cause instanceof Error && /redirect/i.test(cause.message))
    return new Error(
      `The sign-in server at ${host} answered with a redirect, which Clockout doesn't follow for sign-in requests.`,
      { cause: err },
    );
  return new Error(`Couldn't reach the sign-in server at ${host}. Check your connection.`, {
    cause: err,
  });
}

function isLoopback(address: string): boolean {
  const a = address.toLowerCase();
  return /^127\./.test(a) || a === "::1" || /^::ffff:127\./.test(a);
}

/**
 * Before a secret goes over plain http, checks that the host really is this machine. The config
 * allows `http://*.localhost`, and a resolver that doesn't know the name (glibc without
 * nss-myhostname) can send it to DNS, which could answer with a remote address. Does nothing
 * for https. This is the network edge's check; the config schema stays pure.
 */
export async function assertLocalIfPlain(
  url: string,
  resolve: (host: string) => Promise<string[]> = async (h) =>
    (await lookup(h, { all: true })).map((r) => r.address),
): Promise<void> {
  const { protocol, hostname } = new URL(url);
  if (protocol !== "http:") return;
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolve(host).catch(() => [] as string[]);
  if (addresses.length === 0 || !addresses.every(isLoopback))
    throw new Error(
      `${host} doesn't resolve to this machine, so Clockout won't send a sign-in over plain http to it. Use an https:// address.`,
    );
}

/**
 * An authorization server's metadata, from the well-known addresses in the order MCP's
 * authorization spec gives: RFC 8414, then OpenID Connect discovery. Null when none answer with
 * it; a network failure throws.
 */
export async function authServerMetadata(
  issuer: string,
  doFetch: Fetch = fetch,
  opts: { openid?: boolean } = {},
): Promise<AuthServer | null> {
  const { origin, pathname } = new URL(issuer);
  const path = pathname.replace(/\/$/, "");
  const wanted = issuer.replace(/\/+$/, "");
  const urls = [`${origin}/.well-known/oauth-authorization-server${path}`];
  if (opts.openid !== false) {
    urls.push(`${origin}/.well-known/openid-configuration${path}`);
    if (path) urls.push(`${origin}${path}/.well-known/openid-configuration`);
  }
  for (const url of urls) {
    const res = await doFetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    }).catch((err: unknown) => {
      throw reachError(url, err);
    });
    const found = res.ok ? serverMetadata.safeParse(await res.json().catch(() => null)) : null;
    if (found?.success) {
      // RFC 8414 §3.3: the issuer in the metadata must be the one it was asked for, or a
      // server could vouch for another's name.
      if (found.data.issuer !== undefined && found.data.issuer.replace(/\/+$/, "") !== wanted)
        throw new Error(
          `The sign-in server at ${origin} names itself ${found.data.issuer}, not ${issuer}. Clockout won't use it.`,
        );
      return found.data;
    }
  }
  return null;
}

export type Registration =
  | { ok: true; clientId: string }
  | { ok: false; status: number; error?: string | undefined; json: boolean };

/** Registers Clockout as a public client for this sign-in's redirect (RFC 7591). */
export async function registerPublicClient(
  endpoint: string,
  redirectUri: string,
  doFetch: Fetch = fetch,
): Promise<Registration> {
  await assertLocalIfPlain(endpoint);
  const res = await doFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Clockout",
      client_uri: "https://github.com/wreckage0907/clockout",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    ...secretRequest(),
  }).catch((err: unknown) => {
    throw reachError(endpoint, err);
  });
  const body = (await res.json().catch(() => null)) as {
    client_id?: unknown;
    error_description?: unknown;
  } | null;
  if (res.ok && typeof body?.client_id === "string") return { ok: true, clientId: body.client_id };
  return {
    ok: false,
    status: res.status,
    error: typeof body?.error_description === "string" ? body.error_description : undefined,
    json: body !== null,
  };
}

export const tokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
});
export type TokenResponse = z.infer<typeof tokenResponse>;

/** A form POST to a token endpoint; the answer as JSON (null if it isn't). */
export async function tokenRequest(
  endpoint: string,
  params: Record<string, string>,
  doFetch: Fetch = fetch,
): Promise<{ status: number; ok: boolean; json: unknown }> {
  await assertLocalIfPlain(endpoint);
  const res = await doFetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams(params),
    ...secretRequest(),
  }).catch((err: unknown) => {
    throw reachError(endpoint, err);
  });
  return { status: res.status, ok: res.ok, json: await res.json().catch(() => null) };
}

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function randomState(): string {
  return randomBytes(16).toString("base64url");
}

export interface Loopback {
  /** Where the server should send you back; register or pass this exactly. */
  redirectUri: string;
  /**
   * Opens the sign-in page and resolves with the code the server redirects back with.
   * `describeError` turns an `error` parameter into the message to throw.
   */
  code(opts: {
    authUrl: string;
    state: string;
    open: (url: string) => Promise<void>;
    /** Shown in the browser tab once it worked, e.g. "Google Calendar". */
    service: string;
    describeError: (error: string | null) => string;
    /** The message when nobody finishes signing in. */
    timedOut: string;
    timeoutMs?: number;
  }): Promise<string>;
  close(): void;
}

/** Listens on a free port on 127.0.0.1; `path` is the redirect URI's path. */
export async function loopback(path = "/"): Promise<Loopback> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const redirectUri = path === "/" ? origin : `${origin}${path}`;
  return {
    redirectUri,
    code: (opts) =>
      new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(opts.timedOut)),
          opts.timeoutMs ?? 5 * 60_000,
        );
        let settled = false;
        server.on("request", (req, res) => {
          const url = new URL(req.url ?? "/", origin);
          if (url.pathname !== path) {
            res.writeHead(404).end();
            return;
          }
          // Anything that finds the port can knock on it: only a request carrying this
          // sign-in's state (an error from the server included) is allowed to end it.
          if (settled || url.searchParams.get("state") !== opts.state) {
            res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
            res.end("This isn't the response Clockout is waiting for.");
            return;
          }
          const error = url.searchParams.get("error");
          const code = url.searchParams.get("code");
          const ok = !error && code;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            ok
              ? `<h1>Clockout is connected to ${escapeHtml(opts.service)}.</h1><p>You can close this tab.</p>`
              : `<h1>Sign-in didn't finish.</h1><p>${escapeHtml(error ?? "Unexpected response")}. Go back to the terminal.</p>`,
          );
          settled = true;
          clearTimeout(timer);
          if (ok) resolve(code);
          else reject(new Error(opts.describeError(error)));
        });
        void opts.open(opts.authUrl).catch(reject);
      }),
    close: () => server.close(),
  };
}

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c,
  );
}
