import { localTime } from "../../core/time";
import type { GitHubToken } from "./token";

// Turns what @octokit/graphql throws into one readable line with a fix. The raw error carries the
// request (and its Authorization header), so it's never kept: the cause is a plain summary.

type Via = GitHubToken["via"] | undefined;

interface Narrowed {
  status?: number;
  message: string;
  headers: Record<string, string>;
  /** GraphQL errors (`GraphqlResponseError`), with their `type` when GitHub gives one. */
  errors: { type?: string; message: string }[];
  network: boolean;
}

function narrow(err: unknown): Narrowed {
  const o = (err && typeof err === "object" ? err : {}) as Record<string, unknown>;
  const message = err instanceof Error ? err.message : String(err);
  const response = o.response && typeof o.response === "object" ? o.response : {};
  const rawHeaders =
    (o.headers && typeof o.headers === "object" ? o.headers : null) ??
    ("headers" in response && response.headers && typeof response.headers === "object"
      ? response.headers
      : {});
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHeaders)) {
    if (typeof v === "string" || typeof v === "number") headers[k.toLowerCase()] = String(v);
  }
  const errors = Array.isArray(o.errors)
    ? o.errors.flatMap((e: unknown) => {
        if (!e || typeof e !== "object" || !("message" in e)) return [];
        const m = (e as { message: unknown; type?: unknown }).message;
        const t = (e as { type?: unknown }).type;
        return typeof m === "string"
          ? [{ message: m, ...(typeof t === "string" ? { type: t } : {}) }]
          : [];
      })
    : [];
  const status = typeof o.status === "number" ? o.status : undefined;
  const cause = o.cause instanceof Error ? `${o.cause.name} ${o.cause.message}` : "";
  // octokit reports a failed fetch as status 500 with the fetch error as `cause`.
  const network =
    /fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(
      `${message} ${cause}`,
    ) ||
    (o.name === "AbortError" && status === 500);
  return { ...(status !== undefined ? { status } : {}), message, headers, errors, network };
}

const who = (via: Via) =>
  via === "gh" ? "your gh login" : via ? `the token in ${via}` : "the GitHub token";

const renew = (via: Via) =>
  via === "gh"
    ? "Run `gh auth refresh` (or `gh auth login`)."
    : via
      ? `Put a new token in ${via}.`
      : "Run `gh auth login`, or set a new GITHUB_TOKEN.";

/** Scopes GitHub names in an INSUFFICIENT_SCOPES message: "requires one of the following scopes: ['read:org']". */
function scopesIn(text: string): string[] {
  const list = /scopes?: \[([^\]]*)\]/i.exec(text)?.[1] ?? "";
  return [...list.matchAll(/'([^']+)'/g)].flatMap((m) => (m[1] ? [m[1]] : []));
}

/** A readable error for a failed contributions request; `cause` is a summary without the request. */
export function describeGitHubError(err: unknown, via: Via, timezone: string): Error {
  const e = narrow(err);
  const detail = e.errors.length ? e.errors.map((x) => x.message).join("; ") : e.message;
  const cause = new Error(e.status ? `HTTP ${e.status}: ${detail}` : detail);
  const fail = (msg: string) => new Error(`GitHub: ${msg}`, { cause });
  const all = `${e.message} ${detail}`;

  if (e.network) return fail("couldn't reach GitHub. Check your connection and try again.");
  if (e.status === 401 || /bad credentials/i.test(all))
    return fail(`${who(via)} was rejected (expired or revoked). ${renew(via)}`);
  if (/SAML|single sign-on|\bSSO\b/i.test(all))
    return fail(
      via === "gh"
        ? "an organization requires single sign-on for your gh login. Run `gh auth refresh` and authorize the organization in the browser."
        : `an organization requires single sign-on for ${who(via)}. Authorize it for the organization at https://github.com/settings/tokens (Configure SSO).`,
    );
  const remaining = e.headers["x-ratelimit-remaining"];
  if (e.status === 429 || remaining === "0" || /rate limit/i.test(all)) {
    const reset = Number(e.headers["x-ratelimit-reset"]);
    const at =
      Number.isFinite(reset) && reset > 0 ? localTime(new Date(reset * 1000), timezone) : "";
    return fail(
      at
        ? `rate limit reached. It resets at ${at}.`
        : "rate limit reached. Try again in a few minutes.",
    );
  }
  const scopes = scopesIn(all);
  if (scopes.length || e.errors.some((x) => x.type === "INSUFFICIENT_SCOPES")) {
    const need = scopes.join(", ") || "repo, read:org";
    return fail(
      via === "gh"
        ? `your gh login is missing a permission Clockout needs (${need}). Run \`gh auth refresh -s ${scopes[0] ?? "read:org"}\`.`
        : `${who(via)} is missing a permission Clockout needs (${need}). Give the token that scope, or use \`gh auth login\`.`,
    );
  }
  if (e.status === 403 || e.errors.some((x) => x.type === "FORBIDDEN"))
    return fail(
      `GitHub refused the request with ${who(via)} (${detail}). ${via === "gh" ? "Run `gh auth refresh -s repo,read:org`." : "Check the token's permissions, or use `gh auth login`."}`,
    );
  if (e.errors.length) return fail(`the contributions query failed: ${detail}.`);
  if (e.status) return fail(`request failed (HTTP ${e.status}). Try again shortly.`);
  return fail(`request failed: ${detail}.`);
}

/** Partial results from a `GraphqlResponseError`, to use when they're complete enough. */
export function partialData(err: unknown): unknown {
  return err && typeof err === "object" && "data" in err ? err.data : undefined;
}
