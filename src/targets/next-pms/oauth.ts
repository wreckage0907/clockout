import { z } from "zod";
import type { ErpCredentials } from "../../config/credentials";
import { loopback, pkcePair, randomState } from "../../oauth";

// Signing in to a Frappe site (next-pms runs on Frappe) as a public OAuth client: discover the
// server, register Clockout for this sign-in's loopback address, PKCE, refresh token.

export type Fetch = typeof fetch;

const metadata = z.object({
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  revocation_endpoint: z.string().optional(),
});
type Endpoints = z.infer<typeof metadata>;

const tokens = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
});

const RETRY = "Run `clockout connect erp <url>` again.";

/** The site's origin, e.g. "https://erp.example.com". */
export function siteOrigin(url: string): string {
  return new URL(url).origin;
}

/** Where to sign in, from the server's metadata (RFC 8414), or Frappe's usual paths. */
export async function discover(url: string, doFetch: Fetch = fetch): Promise<Endpoints> {
  const origin = siteOrigin(url);
  const res = await doFetch(`${origin}/.well-known/oauth-authorization-server`).catch(() => {
    throw new Error(`Couldn't reach ${origin}. Check the address and your connection.`);
  });
  const found = res.ok ? metadata.safeParse(await res.json().catch(() => null)) : null;
  if (found?.success) return found.data;
  const m = `${origin}/api/method/frappe.integrations.oauth2`;
  return {
    authorization_endpoint: `${m}.authorize`,
    token_endpoint: `${m}.get_token`,
    registration_endpoint: `${m}.register_client`,
    revocation_endpoint: `${m}.revoke_token`,
  };
}

async function register(
  endpoint: string | undefined,
  redirectUri: string,
  doFetch: Fetch,
): Promise<string> {
  const closed = new Error(
    "This ERP doesn't let apps sign in on their own. Ask an admin to turn on “Enable Dynamic Client Registration” in OAuth Settings.",
  );
  if (!endpoint) throw closed;
  const res = await doFetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Clockout",
      client_uri: "https://github.com/wreckage0907/clockout",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    client_id?: string;
    error_description?: string;
  } | null;
  if (res.status === 404) throw closed;
  if (!res.ok || !body?.client_id) {
    throw new Error(
      `The ERP refused to register Clockout${body?.error_description ? `: ${body.error_description}` : ""}.`,
    );
  }
  return body.client_id;
}

export interface ErpConnected {
  url: string;
  clientId: string;
  refreshToken: string;
  user?: string;
}

/**
 * Signs in once: registers Clockout for a loopback address, sends you to the ERP's sign-in
 * page, and trades the code for a refresh token.
 */
export async function connectErp(
  url: string,
  open: (url: string) => Promise<void>,
  opts: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<ErpConnected> {
  const doFetch = opts.fetch ?? fetch;
  const origin = siteOrigin(url);
  const endpoints = await discover(origin, doFetch);
  const server = await loopback("/callback");
  try {
    const clientId = await register(endpoints.registration_endpoint, server.redirectUri, doFetch);
    const { verifier, challenge } = pkcePair();
    const state = randomState();
    const q = new URLSearchParams({
      client_id: clientId,
      redirect_uri: server.redirectUri,
      response_type: "code",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
    });
    const code = await server.code({
      authUrl: `${endpoints.authorization_endpoint}?${q}`,
      state,
      open,
      service: "your ERP",
      describeError: (e) =>
        e === "access_denied"
          ? "Access wasn't allowed, so nothing was connected."
          : `ERP sign-in failed${e ? ` (${e})` : ""}.`,
      timedOut: `Sign-in timed out. ${RETRY}`,
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });

    const res = await doFetch(endpoints.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: server.redirectUri,
        client_id: clientId,
        code_verifier: verifier,
      }),
    });
    const body = tokens.safeParse(await res.json().catch(() => null));
    if (!res.ok || !body.success || !body.data.refresh_token) {
      throw new Error(`The ERP didn't return a long-lived sign-in. ${RETRY}`);
    }
    const user = await whoAmI(origin, body.data.access_token, doFetch);
    return {
      url: origin,
      clientId,
      refreshToken: body.data.refresh_token,
      ...(user ? { user } : {}),
    };
  } finally {
    server.close();
  }
}

async function whoAmI(origin: string, token: string, doFetch: Fetch): Promise<string | undefined> {
  const res = await doFetch(`${origin}/api/method/frappe.auth.get_logged_user`, {
    headers: { authorization: `Bearer ${token}` },
  }).catch(() => null);
  const body = (await res?.json().catch(() => null)) as { message?: unknown } | null;
  return typeof body?.message === "string" ? body.message : undefined;
}

export interface ErpAuth {
  /** A current access token, refreshed when needed (or when `force` is set). */
  token(force?: boolean): Promise<string>;
}

/**
 * Access tokens from the stored refresh token. Frappe hands out a new refresh token with each
 * refresh; `save` keeps it so the next run can sign in.
 */
export function erpAuth(
  creds: ErpCredentials,
  save: (next: ErpCredentials) => Promise<void>,
  doFetch: Fetch = fetch,
): ErpAuth {
  let current = creds;
  let cached: { token: string; until: number } | null = null;
  let pending: Promise<string> | null = null;
  let endpoints: Promise<Endpoints> | null = null;

  const refresh = async (): Promise<string> => {
    endpoints ??= discover(current.url, doFetch);
    const { token_endpoint } = await endpoints.catch((err: Error) => {
      endpoints = null;
      throw err;
    });
    const res = await doFetch(token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: current.refresh_token,
        client_id: current.client_id,
      }),
    }).catch(() => {
      throw new Error(`Couldn't reach ${current.url}.`);
    });
    const json = (await res.json().catch(() => null)) as { error?: string } | null;
    if (!res.ok) {
      if (json?.error === "invalid_grant" || json?.error === "invalid_client") {
        throw new Error(`The ERP sign-in expired or was revoked. ${RETRY}`);
      }
      throw new Error(`ERP sign-in refresh failed (HTTP ${res.status}).`);
    }
    const body = tokens.safeParse(json);
    if (!body.success) throw new Error("The ERP sent an unexpected sign-in response.");
    if (body.data.refresh_token && body.data.refresh_token !== current.refresh_token) {
      current = { ...current, refresh_token: body.data.refresh_token };
      await save(current);
    }
    const life = (body.data.expires_in ?? 3600) * 1000;
    cached = { token: body.data.access_token, until: Date.now() + life - 60_000 };
    return cached.token;
  };

  return {
    token(force = false) {
      if (!force && cached && Date.now() < cached.until) return Promise.resolve(cached.token);
      // One refresh at a time: a rotated refresh token can only be used once.
      pending ??= refresh().finally(() => {
        pending = null;
      });
      return pending;
    },
  };
}

/** Best effort: Frappe may only let confidential clients revoke. */
export async function revokeErp(creds: ErpCredentials, doFetch: Fetch = fetch): Promise<void> {
  const { revocation_endpoint } = await discover(creds.url, doFetch).catch(() => ({
    revocation_endpoint: undefined,
  }));
  if (!revocation_endpoint) return;
  await doFetch(revocation_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      token: creds.refresh_token,
      token_type_hint: "refresh_token",
      client_id: creds.client_id,
    }),
  }).catch(() => undefined);
}
