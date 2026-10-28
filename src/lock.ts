import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { link, mkdir, open, readFile, rename, rm, stat, unlink, utimes } from "node:fs/promises";
import { dirname } from "node:path";

// One thing at a time, across processes (ADR 0012). A scheduled run and the one you started by
// hand both refresh the same rotating sign-in tokens, and both write the same note: whoever
// gets the lock goes first, and the other either waits a moment or says it'll try later.
//
// The lock file holds a random token that only its owner knows. Release removes the file only
// while the token is still ours; a taken-over lock is never deleted by its old owner. A held lock
// has its modification time touched now and then, so "older than STALE_MS" means the holder died,
// not that it's slow.

/** A lock not touched for this long was left behind by a process that died; it's taken over. */
const STALE_MS = 10 * 60 * 1000;
/** How often a held lock is touched; well inside STALE_MS. */
const HEARTBEAT_MS = 60 * 1000;

export interface Lock {
  /** Removes the lock if it's still ours; safe to call twice. */
  release(): Promise<void>;
}

export interface LockOptions {
  /** How long to wait for it; 0 (default) means "don't wait, tell me it's taken". */
  waitMs?: number;
  /** For the lock's own text, so a stuck lock says who held it. */
  what?: string;
  now?: () => number;
  /** How old an untouched lock must be to count as abandoned. Default 10 minutes. */
  staleMs?: number;
  /** How often to touch the lock while held. Default a minute. */
  heartbeatMs?: number;
}

/** Locks this process holds, so a signal handler can let go of them synchronously. */
const held = new Map<string, { path: string; timer: NodeJS.Timeout }>();
let watching = false;

/**
 * Removes every lock this process still holds, synchronously: for a signal handler or `exit`,
 * where `finally` blocks won't run and an awaited release can't finish.
 */
export function releaseHeldLocks(): void {
  for (const [token, { path, timer }] of held) {
    clearInterval(timer);
    try {
      if (tokenOf(readFileSync(path, "utf8")) === token) rmSync(path, { force: true });
    } catch {
      // Already gone, or not ours any more.
    }
  }
  held.clear();
}

/** Takes the lock at `path`, or null when someone else has it and waiting didn't help. */
export async function takeLock(path: string, opts: LockOptions = {}): Promise<Lock | null> {
  const now = opts.now ?? Date.now;
  const staleMs = opts.staleMs ?? STALE_MS;
  const deadline = now() + (opts.waitMs ?? 0);
  const token = randomUUID();
  for (;;) {
    if (await create(path, opts.what ?? "", token)) return hold(path, token, opts);
    // Left behind by a run that died (a crash, a killed terminal): take it over.
    if (await breakIfStale(path, now, staleMs)) continue;
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
  const lock = await takeLock(path, { waitMs: 2000, ...opts });
  if (!lock)
    throw new Error(
      `Another Clockout run is using this right now${opts.what ? ` (${opts.what})` : ""}. Try again in a moment.`,
    );
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

function hold(path: string, token: string, opts: LockOptions): Lock {
  if (!watching) {
    watching = true;
    process.once("exit", releaseHeldLocks);
  }
  const timer = setInterval(() => {
    void touch(path, token);
  }, opts.heartbeatMs ?? HEARTBEAT_MS);
  timer.unref();
  held.set(token, { path, timer });
  return {
    release: async () => {
      const mine = held.get(token);
      if (!mine) return;
      held.delete(token);
      clearInterval(mine.timer);
      if (tokenOf(await readFile(path, "utf8").catch(() => "")) === token)
        await rm(path, { force: true });
    },
  };
}

/** Marks the lock as alive, as long as it's still ours. */
async function touch(path: string, token: string): Promise<void> {
  try {
    if (tokenOf(await readFile(path, "utf8")) !== token) return;
    const at = new Date();
    await utimes(path, at, at);
  } catch {
    // Gone; release or the next taker sorts it out.
  }
}

/**
 * `O_EXCL` create: exactly one process wins. The file is written under a private name first and
 * linked into place, so nobody reads a lock that's still empty.
 */
async function create(path: string, what: string, token: string): Promise<boolean> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => undefined);
  const temp = `${path}.${token}.new`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(
        `${JSON.stringify({ pid: process.pid, at: new Date().toISOString(), what, token })}\n`,
      );
    } finally {
      await file.close();
    }
    await link(temp, path);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw err;
  } finally {
    await unlink(temp).catch(() => undefined);
  }
}

/**
 * Removes the lock at `path` if it's abandoned; true when it's gone (or was) and a retry is worth
 * it. Waiters that all see the same stale lock race on `rename`, which only one can win; the
 * winner re-checks what it moved, and puts it back if it turned out to be someone's fresh lock.
 */
async function breakIfStale(path: string, now: () => number, staleMs: number): Promise<boolean> {
  const age = await stat(path).then(
    (s) => now() - s.mtimeMs,
    () => null,
  );
  if (age === null) return true; // vanished: try to create again
  if (age <= staleMs) return false;
  const aside = `${path}.${randomUUID()}.stale`;
  try {
    await rename(path, aside);
  } catch {
    return true; // someone else moved it first
  }
  const movedAge = await stat(aside).then(
    (s) => now() - s.mtimeMs,
    () => null,
  );
  if (movedAge !== null && movedAge <= staleMs) {
    // We grabbed a lock that was taken over a moment ago; give it back (fails if yet another
    // one has appeared, in which case that one stands).
    await link(aside, path).catch(() => undefined);
  }
  await rm(aside, { force: true });
  return true;
}

function tokenOf(text: string): string | null {
  try {
    const said = JSON.parse(text) as { token?: unknown };
    return typeof said.token === "string" ? said.token : null;
  } catch {
    return null;
  }
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
