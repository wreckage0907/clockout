import { z } from "zod";
import type { Config } from "../../config/schema";
import { loopback, pkcePair, randomState } from "../../oauth";

export { pkcePair };

/** Read-only access to events; nothing else. */
export const GOOGLE_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";
const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
/** Setup and troubleshooting, linked from error messages (docs/ isn't in the npm package). */
export const GOOGLE_DOCS =
  "https://github.com/wreckage0907/clockout/blob/main/docs/google-setup.md";

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
      `No Google sign-in client is set up yet. Follow ${GOOGLE_DOCS} (5 minutes, once), then run \`clockout connect google\` again.`,
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

/** What Google's token endpoint says when it refuses. */
const tokenError = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

const unreachable = (cause: unknown) =>
  new Error("Google Calendar: couldn't reach Google. Check your connection and try again.", {
    cause,
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
      timedOut: `Google Calendar: sign-in timed out. If Google showed an error page ("Access blocked", "redirect_uri_mismatch"), that's the cause: see Troubleshooting in ${GOOGLE_DOCS}. Otherwise run \`clockout connect google\` again.`,
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
    }).catch((err: unknown) => {
      throw unreachable(err);
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw exchangeError(res.status, json);
    const body = tokenResponse.safeParse(json);
    if (!body.success) {
      throw new Error(
        "Google Calendar: Google's answer to the sign-in wasn't readable. Run `clockout connect google` again.",
        {
          cause: new Error(body.error.message),
        },
      );
    }
    if (!body.data.refresh_token) {
      throw new Error(
        "Google Calendar: Google didn't return a lasting sign-in. Remove Clockout at https://myaccount.google.com/permissions, then run `clockout connect google` again.",
        { cause: new Error("token response without refresh_token") },
      );
    }
    return { refreshToken: body.data.refresh_token, scope: body.data.scope ?? GOOGLE_SCOPE };
  } finally {
    server.close();
  }
}

/** Google's `error` (and description) from a refused token request, without anything secret. */
function refusal(status: number, json: unknown): { error: string; cause: Error } {
  const e = tokenError.safeParse(json);
  const error = e.success ? e.data.error : "";
  const desc = e.success && e.data.error_description ? `: ${e.data.error_description}` : "";
  return { error, cause: new Error(`HTTP ${status} ${error || "(no error code)"}${desc}`) };
}

const WRONG_CLIENT = `Check client_id and client_secret under [google] in config.toml (or CLOCKOUT_GOOGLE_CLIENT_ID / CLOCKOUT_GOOGLE_CLIENT_SECRET): they must come from a "Desktop app" client. See ${GOOGLE_DOCS}`;

/** Trading the sign-in code for a refresh token failed. */
export function exchangeError(status: number, json: unknown): Error {
  const { error, cause } = refusal(status, json);
  const fail = (msg: string) => new Error(`Google Calendar: ${msg}`, { cause });
  switch (error) {
    case "invalid_client":
    case "unauthorized_client":
      return fail(`Google didn't accept Clockout's sign-in client (${error}). ${WRONG_CLIENT}`);
    case "redirect_uri_mismatch":
      return fail(`the sign-in client isn't a "Desktop app" client (${error}). ${WRONG_CLIENT}`);
    case "invalid_grant":
      return fail(
        "the sign-in code expired or was already used. Run `clockout connect google` again.",
      );
    default:
      return fail(
        `Google refused the sign-in (${error || `HTTP ${status}`}). Run \`clockout connect google\` again.`,
      );
  }
}

export function googleError(error: string | null): string {
  const fail = (msg: string) => `Google Calendar: ${msg}`;
  switch (error) {
    case "access_denied":
      return fail(
        `access wasn't allowed, so nothing was connected. If Google said the app hasn't completed verification, publish it or add your account as a test user (${GOOGLE_DOCS}, step 5).`,
      );
    case "admin_policy_enforced":
      return fail(
        `your Google Workspace admin blocks this app. See ${GOOGLE_DOCS} for what to ask them.`,
      );
    case "org_internal":
      return fail(
        `the sign-in client is "Internal" to another organization, so this account can't use it. Sign in with an account from that organization, or set the client's audience to External (${GOOGLE_DOCS}, step 3).`,
      );
    case "invalid_client":
    case "unauthorized_client":
      return fail(`Google didn't accept Clockout's sign-in client (${error}). ${WRONG_CLIENT}`);
    case "redirect_uri_mismatch":
    case "invalid_request":
      return fail(`Google rejected the sign-in request (${error}). ${WRONG_CLIENT}`);
    default:
      return fail(
        `sign-in failed${error ? ` (${error})` : ""}. Run \`clockout connect google\` again.`,
      );
  }
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
  }).catch((err: unknown) => {
    throw unreachable(err);
  });
  const json: unknown = await res.json().catch(() => null);
  if (!res.ok) throw refreshError(res.status, json);
  const body = tokenResponse.safeParse(json);
  if (!body.success)
    throw new Error("Google Calendar: Google's token answer wasn't readable. Try again shortly.", {
      cause: new Error(body.error.message),
    });
  return body.data.access_token;
}

/** Refreshing the stored sign-in failed. */
export function refreshError(status: number, json: unknown): Error {
  const { error, cause } = refusal(status, json);
  const fail = (msg: string) => new Error(`Google Calendar: ${msg}`, { cause });
  if (error === "invalid_grant")
    return fail(
      `the sign-in was revoked or expired. Run \`clockout connect google\` again. If this happens every week, your Google app is still in "Testing": publish it (${GOOGLE_DOCS}, step 5).`,
    );
  if (error === "invalid_client" || error === "unauthorized_client")
    return fail(
      `the sign-in client changed or was deleted since you connected (${error}). Run \`clockout connect google\` again.`,
    );
  return fail(`refreshing the sign-in failed (${error || `HTTP ${status}`}). Try again shortly.`);
}

export async function revoke(refreshToken: string, doFetch: Fetch = fetch): Promise<void> {
  await doFetch(`${REVOKE_URL}?${new URLSearchParams({ token: refreshToken })}`, {
    method: "POST",
  }).catch(() => undefined);
}
