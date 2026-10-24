import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolvePaths } from "./config/paths";
import { redactSecrets } from "./core/secrets";

// What went wrong, in full, for when the one-line message on screen isn't enough: which source
// or helper failed and the underlying error behind the readable one. Stays on this machine, is
// readable only by you, and never holds tokens (anything that looks like one is redacted).

const MAX_BYTES = 256 * 1024;

export function errorLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolvePaths(env).dataDir, "errors.log");
}

/** The message and every `cause` behind it, one per line. */
export function describeError(err: unknown): string {
  const lines: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e !== undefined && e !== null && depth < 5; depth++) {
    lines.push(e instanceof Error ? e.message : String(e));
    e = e instanceof Error ? e.cause : undefined;
  }
  return lines.join("\n  caused by: ");
}

/** Appends a failure to the error log; never throws (a log that can't be written isn't a failure). */
export async function logError(
  where: string,
  err: unknown,
  file: string = errorLogPath(),
  now = new Date(),
): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    const size = await stat(file).then(
      (s) => s.size,
      () => 0,
    );
    if (size > MAX_BYTES) {
      const text = await readFile(file, "utf8");
      await writeFile(file, text.slice(text.indexOf("\n", text.length / 2) + 1), { mode: 0o600 });
    }
    const entry = `${now.toISOString()} ${where}: ${redactSecrets(describeError(err))}\n`;
    await appendFile(file, entry, { mode: 0o600 });
  } catch {
    // Nowhere to report it; the message on screen still says what's wrong.
  }
}
