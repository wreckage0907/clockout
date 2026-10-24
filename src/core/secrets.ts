// Things that look like a token or key: never sent to the AI, never written to the error log.

const TOKEN =
  /\b(?:gh[opsur]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|sk-[\w-]{20,}|xox[abprs]-[\w-]{10,}|ya29\.[\w-]{20,}|1\/\/[\w-]{20,}|AKIA[0-9A-Z]{16}|GOCSPX-[\w-]{10,})/g;
const LONG = /[A-Za-z0-9_+/=-]{32,}/g;

/** A long run of letters and digits mixed together, the way keys and tokens look. */
function random(word: string): boolean {
  // A link or path ("github.com/acme0907/app/blob/main/docs") has only short parts between slashes.
  if (word.includes("/")) return word.split("/").some((part) => part.length >= 16 && random(part));
  return (word.match(/\d/g)?.length ?? 0) >= 4 && (word.match(/[A-Za-z]/g)?.length ?? 0) >= 4;
}

export function hasSecret(text: string): boolean {
  return new RegExp(TOKEN.source).test(text) || (text.match(LONG) ?? []).some(random);
}

/** The text with anything that looks like a token or key replaced by "[redacted]". */
export function redactSecrets(text: string): string {
  return text.replace(TOKEN, "[redacted]").replace(LONG, (w) => (random(w) ? "[redacted]" : w));
}
