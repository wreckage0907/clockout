import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

// One thing at a time, across processes (ADR 0012). A scheduled run and the one you started by
// hand both refresh the same rotating sign-in tokens, and both write the same note: whoever
// gets the lock goes first, and the other either waits a moment or says it'll try later.

/** A lock older than this was left behind by a process that died; it's taken over. */
const STALE_MS = 10 * 60 * 1000;

export interface Lock {
  /** Removes the lock; safe to call twice. */
  release(): Promise<void>;
}

export interface LockOptions {
  /** How long to wait for it; 0 (default) means "don't wait, tell me it's taken". */
  waitMs?: number;
  /** For the lock's own text, so a stuck lock says who held it. */
  what?: string;
  now?: () => number;
}

/** Takes the lock at `path`, or null when someone else has it and waiting didn't help. */
export async function takeLock(path: string, opts: LockOptions = {}): Promise<Lock | null> {
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.waitMs ?? 0);
  for (;;) {
    const taken = await create(path, opts.what ?? "");
    if (taken) return { release: () => release(path) };
    // Left behind by a run that died (a crash, a killed terminal): take it over.
    const age = await stat(path).then(
      (s) => now() - s.mtimeMs,
      () => 0,
    );
    if (age > STALE_MS) {
      await rm(path, { force: true });
      continue;
    }
    if (now() >= deadline) return null;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** Runs `fn` holding the lock; throws if it can't be had, so callers say why. */
export async function withLock<T>(
  path: string,
  fn: () => Promise<T>,
  opts: LockOptions = {},
): Promise<T> {
  const held = await takeLock(path, { waitMs: 2000, ...opts });
  if (!held)
    throw new Error(
      `Another Clockout run is using this right now${opts.what ? ` (${opts.what})` : ""}. Try again in a moment.`,
    );
  try {
    return await fn();
  } finally {
    await held.release();
  }
}

/** `O_EXCL` create: exactly one process wins. */
async function create(path: string, what: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => undefined);
  try {
    const file = await open(path, "wx", 0o600);
    await file.writeFile(
      `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), what })}\n`,
    );
    await file.close();
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  }
}

async function release(path: string): Promise<void> {
  await rm(path, { force: true });
}

/** Who holds the lock, for "wait, or say who has it". */
export async function lockHolder(path: string): Promise<string | null> {
  try {
    const said = JSON.parse(await readFile(path, "utf8")) as { pid?: number; at?: string };
    return said.pid ? `pid ${said.pid}${said.at ? ` since ${said.at}` : ""}` : null;
  } catch {
    return null;
  }
}
