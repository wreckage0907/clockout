// Things that look like a token or key: never sent to the AI, never written to the error log.

const TOKEN =
  /\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|xox[abprs]-[\w-]{10,}|ya29\.[\w-]{20,}|1\/\/[\w-]{20,}|AKIA[0-9A-Z]{16}|GOCSPX-[\w-]{10,})/g;
const LONG = /[A-Za-z0-9_+/=-]{32,}/g;

// Key-based: whatever the value looks like, what follows these names is a secret. A token can be
// all letters or short, so the pattern checks above would miss it.
const KEYS = "access_token|refresh_token|id_token|client_secret|code_verifier|api_key|apikey";
const SECRET_KEY = new RegExp(`(?<![A-Za-z0-9_])(${KEYS})(=|%3D)([^&\\s"'<>]+)`, "gi");
// `code=` is also in ordinary text ("exit code=1"), so only a long value counts: an OAuth code.
const CODE_PARAM = /(?<![A-Za-z0-9_])(code)(=|%3D)([^&\s"'<>]{8,})/gi;
const JSON_SECRET = new RegExp(`("(?:${KEYS}|password|secret|token)"\\s*:\\s*)"([^"]*)"`, "gi");
const AUTH_HEADER =
  /\b((?:proxy-)?authorization|cookie|set-cookie|x-api-key)(\s*[:=]\s*)(?:(?:Bearer|Basic|Token)\s+)?[^\r\n,;"']+/gi;
const BEARER = /\b(Bearer)(\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

/** A word after "Bearer": a token if it isn't a plain lowercase word ("Bearer authentication"). */
function bearerToken(value: string): boolean {
  return value.length >= 20 || /[^a-z]/.test(value);
}

/** A long run of letters and digits mixed together, the way keys and tokens look. */
function random(word: string): boolean {
  // A link or path ("github.com/acme0907/app/blob/main/docs") has only short parts between slashes.
  if (word.includes("/")) return word.split("/").some((part) => part.length >= 16 && random(part));
  return (word.match(/\d/g)?.length ?? 0) >= 4 && (word.match(/[A-Za-z]/g)?.length ?? 0) >= 4;
}

/**
 * Whether text holds a token or key. Only looks at shapes and at the named keys above (not
 * `code=` or a bare `Bearer`), so an ordinary title or sentence is never rejected for them.
 */
export function hasSecret(text: string): boolean {
  return (
    new RegExp(TOKEN.source).test(text) ||
    new RegExp(SECRET_KEY.source, "i").test(text) ||
    new RegExp(JSON_SECRET.source, "i").test(text) ||
    (text.match(LONG) ?? []).some(random)
  );
}

/**
 * The text with anything that looks like a token or key replaced by "[redacted]", and the
 * value after a key that names one (`refresh_token=…`, `"access_token":"…"`, `Authorization: …`),
 * whatever it looks like.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(AUTH_HEADER, (_m, name: string, sep: string) => `${name}${sep}[redacted]`)
    .replace(BEARER, (m, name: string, space: string, value: string) =>
      bearerToken(value) ? `${name}${space}[redacted]` : m,
    )
    .replace(SECRET_KEY, "$1$2[redacted]")
    .replace(CODE_PARAM, "$1$2[redacted]")
    .replace(JSON_SECRET, '$1"[redacted]"')
    .replace(TOKEN, "[redacted]")
    .replace(LONG, (w) => (random(w) ? "[redacted]" : w));
}
