import { z } from "zod";
import type { McpCredentials } from "../config/credentials";
import { isSafeSite } from "../config/schema";
import {
  type AuthServer,
  authServerMetadata,
  type Fetch,
  loopback,
  pkcePair,
  randomState,
  registerPublicClient,
  tokenRequest,
  tokenResponse,
} from "../oauth";
import { McpAuthError, mcpClient } from "./client";

// Signing in to an MCP server the way its authorization spec says: the server's 401 points to
// its protected-resource metadata (RFC 9728), that names the authorization server (RFC 8414),
// Clockout registers itself there (RFC 7591) and signs in with PKCE and a loopback redirect,
// asking for tokens for this server only (RFC 8707).

const resourceMetadata = z.object({
  resource: z.string(),
  authorization_servers: z.array(z.string()).min(1),
  scopes_supported: z.array(z.string()).optional(),
});

export interface McpAuthPlan {
  resource: string;
  scope?: string | undefined;
  server: AuthServer;
}

const retry = (name: string) => `Run \`clockout connect ${name}\` again.`;

/** `key="value"` from a `WWW-Authenticate: Bearer …` header. */
function challengeParam(header: string | null, key: string): string | undefined {
  if (!header) return undefined;
  return new RegExp(`(?:^|[\\s,])${key}="([^"]*)"`, "i").exec(header)?.[1];
}

/**
 * Where to sign in to this server, or null when it answers without one. Asks the server first
 * (an `initialize` without a token), then reads the metadata it points to.
 */
export async function discoverMcpAuth(
  name: string,
  url: string,
  doFetch: Fetch = fetch,
): Promise<McpAuthPlan | null> {
  const probe = mcpClient({ url, name, fetch: doFetch });
  let challenge: string | null;
  try {
    await probe.initialize();
    return null;
  } catch (err) {
    if (!(err instanceof McpAuthError)) throw err;
    challenge = err.challenge;
  }

  const { origin, pathname } = new URL(url);
  const path = pathname.replace(/\/$/, "");
  const pointed = challengeParam(challenge, "resource_metadata");
  const candidates = pointed
    ? [new URL(pointed, url).href]
    : [
        ...(path ? [`${origin}/.well-known/oauth-protected-resource${path}`] : []),
        `${origin}/.well-known/oauth-protected-resource`,
      ];
  let prm: z.infer<typeof resourceMetadata> | null = null;
  for (const candidate of candidates) {
    if (new URL(candidate).origin !== origin) continue;
    const res = await doFetch(candidate, { headers: { accept: "application/json" } });
    const found = res.ok ? resourceMetadata.safeParse(await res.json().catch(() => null)) : null;
    if (found?.success) {
      prm = found.data;
      break;
    }
  }
  if (!prm)
    throw new Error(
      `${name} asks for a sign-in but doesn't say where (no protected-resource metadata at ${origin}).`,
    );
  // The metadata must be about this server, or a token for it could be sent elsewhere.
  if (new URL(prm.resource, url).origin !== origin)
    throw new Error(`${name}'s sign-in metadata is for a different server (${prm.resource}).`);

  const issuer = prm.authorization_servers[0] as string;
  if (!isSafeSite(issuer))
    throw new Error(
      `${name} signs in through ${issuer}, which isn't https. Clockout won't use it.`,
    );
  const server = await authServerMetadata(issuer, doFetch);
  if (!server)
    throw new Error(`Couldn't find how to sign in at ${new URL(issuer).origin} for ${name}.`);
  const endpoints = [server.authorization_endpoint, server.token_endpoint];
  if (server.registration_endpoint) endpoints.push(server.registration_endpoint);
  if (!endpoints.every((e) => URL.canParse(e) && isSafeSite(e)))
    throw new Error(`${name}'s sign-in pages aren't all https. Clockout won't use them.`);
  const methods = server.code_challenge_methods_supported;
  if (methods && !methods.includes("S256"))
    throw new Error(`${name}'s sign-in doesn't support PKCE (S256), so Clockout can't use it.`);

  const scope = challengeParam(challenge, "scope") ?? prm.scopes_supported?.join(" ");
  return { resource: prm.resource, scope: scope || undefined, server };
}

/**
 * Signs in once: registers Clockout for a loopback address, sends you to the server's sign-in
 * page, and trades the code for tokens. Null when the server needs no sign-in.
 */
export async function connectMcp(
  name: string,
  url: string,
  open: (url: string) => Promise<void>,
  opts: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<McpCredentials | null> {
  const doFetch = opts.fetch ?? fetch;
  const plan = await discoverMcpAuth(name, url, doFetch);
  if (!plan) return null;
  const { server, resource } = plan;
  if (!server.registration_endpoint)
    throw new Error(
      `${name} doesn't let apps register themselves (no dynamic client registration), so Clockout can't sign in to it.`,
    );
  const redirect = await loopback("/callback");
  try {
    const reg = await registerPublicClient(
      server.registration_endpoint,
      redirect.redirectUri,
      doFetch,
    );
    if (!reg.ok)
      throw new Error(
        `${name} refused to register Clockout${reg.error ? `: ${reg.error}` : ` (HTTP ${reg.status})`}.`,
      );
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    const q = new URLSearchParams({
      client_id: reg.clientId,
      redirect_uri: redirect.redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      resource,
    });
    if (plan.scope) q.set("scope", plan.scope);
    const code = await redirect.code({
      authUrl: `${server.authorization_endpoint}?${q}`,
      state,
      open,
      service: name,
      describeError: (e) =>
        e === "access_denied"
          ? "Access wasn't allowed, so nothing was connected."
          : `Sign-in to ${name} failed${e ? ` (${e})` : ""}.`,
      timedOut: `Sign-in timed out. ${retry(name)}`,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });

    const res = await tokenRequest(
      server.token_endpoint,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: redirect.redirectUri,
        client_id: reg.clientId,
        code_verifier: verifier,
        resource,
      },
      doFetch,
    );
    const tokens = tokenResponse.safeParse(res.json);
    if (!res.ok || !tokens.success)
      throw new Error(`${name} didn't finish the sign-in (HTTP ${res.status}). ${retry(name)}`);
    return {
      url,
      resource,
      token_endpoint: server.token_endpoint,
      ...(server.revocation_endpoint ? { revocation_endpoint: server.revocation_endpoint } : {}),
      client_id: reg.clientId,
      ...withTokens(tokens.data),
      connected_at: new Date().toISOString(),
    };
  } finally {
    redirect.close();
  }
}

/** Tokens as saved; `expires_at` is when to stop using the access token, a little early. */
function withTokens(t: z.infer<typeof tokenResponse>, now = Date.now()) {
  const life = t.expires_in;
  return {
    access_token: t.access_token,
    ...(t.refresh_token ? { refresh_token: t.refresh_token } : {}),
    ...(life
      ? { expires_at: new Date(now + (life - Math.min(60, life / 2)) * 1000).toISOString() }
      : {}),
  };
}

/**
 * Runs a refresh holding the credentials lock: `fn` gets the sign-in as saved right now and a
 * `save` that doesn't take the lock again (see `withMcpCredentials`).
 */
export type RefreshLock = <T>(
  fn: (stored: McpCredentials | null, save: (next: McpCredentials) => Promise<void>) => Promise<T>,
) => Promise<T>;

/**
 * Access tokens for a connected server: the saved one while it lasts, then a refresh. A new
 * refresh token from the server replaces the old one, and `save` keeps it for the next run.
 */
export function mcpAuth(
  name: string,
  creds: McpCredentials,
  save: (next: McpCredentials) => Promise<void>,
  doFetch: Fetch = fetch,
  exclusive?: RefreshLock,
): (force?: boolean) => Promise<string> {
  let current = creds;
  let pending: Promise<string> | null = null;
  const fresh = () => !current.expires_at || Date.parse(current.expires_at) > Date.now();

  // With a `RefreshLock`, a refresh starts from the sign-in as saved now, under the lock that
  // guards the file: a scheduled run may have rotated the refresh token since this one started,
  // and the old one is spent. Without one (the tests, `connect`), `save` is all there is.
  const refresh = (force: boolean): Promise<string> =>
    (exclusive ?? ((fn) => fn(null, save)))(async (stored, saveLocked) => {
      if (exclusive) {
        if (!stored)
          throw new Error(`The sign-in to ${name} was removed. ${retry(name)}`, {
            cause: new Error("no saved sign-in for this server"),
          });
        if (
          stored.refresh_token !== current.refresh_token ||
          stored.access_token !== current.access_token
        ) {
          const refused = current.access_token;
          current = stored;
          // Someone else already refreshed: use that, unless it's the very token just refused.
          if ((!force || stored.access_token !== refused) && fresh()) return current.access_token;
        }
      }
      return refreshNow(saveLocked);
    });

  const refreshNow = async (saveNext: (next: McpCredentials) => Promise<void>): Promise<string> => {
    if (!current.refresh_token)
      throw new Error(`The sign-in to ${name} has expired. ${retry(name)}`);
    const res = await tokenRequest(
      current.token_endpoint,
      {
        grant_type: "refresh_token",
        refresh_token: current.refresh_token,
        client_id: current.client_id,
        resource: current.resource,
      },
      doFetch,
    ).catch((err: unknown) => {
      throw new Error(`Couldn't reach ${name}'s sign-in server.`, { cause: err });
    });
    if (!res.ok) {
      if (res.status < 500)
        throw new Error(`The sign-in to ${name} expired or was revoked. ${retry(name)}`, {
          cause: new Error(`token endpoint HTTP ${res.status}`),
        });
      throw new Error(
        `${name}'s sign-in server isn't answering (HTTP ${res.status}). Try again later.`,
      );
    }
    const tokens = tokenResponse.safeParse(res.json);
    if (!tokens.success) throw new Error(`${name} sent an unexpected sign-in response.`);
    // Keeps the refresh token when the server doesn't send a new one.
    const { expires_at: _, ...rest } = current;
    current = { ...rest, ...withTokens(tokens.data) };
    await saveNext(current);
    return current.access_token;
  };

  return (force = false) => {
    if (!force && fresh()) return Promise.resolve(current.access_token);
    // One refresh at a time: a rotated refresh token can only be used once.
    pending ??= refresh(force).finally(() => {
      pending = null;
    });
    return pending;
  };
}

/** Best effort: tells the server to forget the sign-in, if it has somewhere to say so. */
export async function revokeMcp(creds: McpCredentials, doFetch: Fetch = fetch): Promise<void> {
  if (!creds.revocation_endpoint) return;
  const token = creds.refresh_token ?? creds.access_token;
  await doFetch(creds.revocation_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token,
      token_type_hint: creds.refresh_token ? "refresh_token" : "access_token",
      client_id: creds.client_id,
    }),
  }).catch(() => undefined);
}
