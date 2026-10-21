import { z } from "zod";
import type { Config } from "../../config/schema";
import { loopback, pkcePair, randomState } from "../../oauth";

export { pkcePair };

/** Read-only access to events; nothing else. */
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";

/**
 * Clockout's own OAuth client, for "Desktop app" sign-in. A desktop client's secret can't be
 * kept secret and isn't treated as one by Google; PKCE protects the flow. Empty until the
 * project's client is created (docs/google-setup.md); users can set their own in config.
 */
const BUILT_IN = { client_id: "", client_secret: "" };

export interface GoogleClient {
  client_id: string;
  client_secret: string;
}

export function googleClient(
  config: Config | null,
  env: NodeJS.ProcessEnv = process.env,
): GoogleClient {
  const client_id =
    env.CLOCKOUT_GOOGLE_CLIENT_ID || config?.google?.client_id || BUILT_IN.client_id;
  const client_secret =
    env.CLOCKOUT_GOOGLE_CLIENT_SECRET || config?.google?.client_secret || BUILT_IN.client_secret;
  if (!client_id || !client_secret) {
    throw new Error(
      "No Google sign-in client is set up yet. Follow docs/google-setup.md (5 minutes, once), then run `clockout connect google` again.",
    );
  }
  return { client_id, client_secret };
}

export type Fetch = typeof fetch;

const tokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
  id_token: z.string().optional(),
});

export function authUrl(
  client: GoogleClient,
  redirectUri: string,
  challenge: string,
  state: string,
): string {
  const q = new URLSearchParams({
    client_id: client.client_id,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: GOOGLE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    access_type: "offline", // a refresh token, so you only connect once
    prompt: "consent",
  });
  return `${AUTH_URL}?${q}`;
}

export interface Connected {
  refreshToken: string;
  scope: string;
}

/**
 * Runs the sign-in once: listens on 127.0.0.1, sends you to Google, and trades the returned
 * code for a refresh token. `open` shows the URL (opens a browser in the CLI).
 */
export async function connectGoogle(
  client: GoogleClient,
  open: (url: string) => Promise<void>,
  opts: { fetch?: Fetch; timeoutMs?: number } = {},
): Promise<Connected> {
  const doFetch = opts.fetch ?? fetch;
  const { verifier, challenge } = pkcePair();
  const state = randomState();
  const server = await loopback();
  const redirectUri = server.redirectUri;

  try {
    const code = await server.code({
      authUrl: authUrl(client, redirectUri, challenge, state),
      state,
      open,
      service: "Google Calendar",
      describeError: googleError,
      timedOut: "Sign-in timed out. Run `clockout connect google` again.",
      ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
    });

    const res = await doFetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        code_verifier: verifier,
      }),
    });
    const body = tokenResponse.safeParse(await res.json().catch(() => null));
    if (!res.ok || !body.success || !body.data.refresh_token) {
      throw new Error(
        "Google didn't return a long-lived token. Run `clockout connect google` again.",
      );
    }
    return { refreshToken: body.data.refresh_token, scope: body.data.scope ?? GOOGLE_SCOPE };
  } finally {
    server.close();
  }
}

function googleError(error: string | null): string {
  if (error === "access_denied") return "Access wasn't allowed, so nothing was connected.";
  if (error === "admin_policy_enforced") {
    return "Your Google Workspace admin blocks this app. See docs/google-setup.md for what to ask them.";
  }
  return `Google sign-in failed${error ? ` (${error})` : ""}.`;
}

/** A short-lived access token from the stored refresh token. */
export async function accessToken(
  client: GoogleClient,
  refreshToken: string,
  doFetch: Fetch = fetch,
): Promise<string> {
  const res = await doFetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: client.client_id,
      client_secret: client.client_secret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  }).catch(() => {
    throw new Error("Google Calendar: couldn't reach Google.");
  });
  const json = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) {
    if (json?.error === "invalid_grant") {
      throw new Error(
        "Google Calendar: the connection was revoked or expired. Run `clockout connect google` again.",
      );
    }
    throw new Error(`Google Calendar: sign-in refresh failed (HTTP ${res.status}).`);
  }
  const body = tokenResponse.safeParse(json);
  if (!body.success) throw new Error("Google Calendar: unexpected token response.");
  return body.data.access_token;
}

export async function revoke(refreshToken: string, doFetch: Fetch = fetch): Promise<void> {
  await doFetch(`${REVOKE_URL}?${new URLSearchParams({ token: refreshToken })}`, {
    method: "POST",
  }).catch(() => undefined);
}
