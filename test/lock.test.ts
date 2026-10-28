import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { releaseHeldLocks, takeLock, withLock } from "../src/lock";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clockout-lock-"));
});
afterEach(async () => {
  releaseHeldLocks();
  await rm(dir, { recursive: true, force: true });
});

const longAgo = new Date(Date.now() - 60 * 60 * 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("lock ownership", () => {
  it("writes a token and leaves no scratch files behind", async () => {
    const path = join(dir, "a.lock");
    const lock = await takeLock(path, { what: "test" });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      pid: process.pid,
      what: "test",
      token: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(await readdir(dir)).toEqual(["a.lock"]);
    await lock?.release();
    expect(await readdir(dir)).toEqual([]);
  });

  it("release leaves a lock someone else took over alone", async () => {
    const path = join(dir, "a.lock");
    const mine = await takeLock(path, { staleMs: 1000 });
    // Mine looks abandoned (a long suspend, say) and another run takes it over.
    await utimes(path, longAgo, longAgo);
    const theirs = await takeLock(path, { staleMs: 1000 });
    expect(theirs).not.toBeNull();
    await mine?.release();
    expect(await takeLock(path)).toBeNull(); // theirs still stands
    await theirs?.release();
    expect(await readdir(dir)).toEqual([]);
  });

  it("release is safe to call twice", async () => {
    const path = join(dir, "a.lock");
    const first = await takeLock(path);
    await first?.release();
    const second = await takeLock(path);
    await first?.release(); // the old handle must not remove the new lock
    expect(await takeLock(path)).toBeNull();
    await second?.release();
  });
});

describe("taking over a stale lock", () => {
  it("takes over a lock from an older version with no token", async () => {
    const path = join(dir, "a.lock");
    await writeFile(path, JSON.stringify({ pid: 1 }));
    await utimes(path, longAgo, longAgo);
    expect(await takeLock(path)).not.toBeNull();
  });

  it("lets only one of many waiters win a stale lock", async () => {
    const path = join(dir, "a.lock");
    await writeFile(path, JSON.stringify({ pid: 1 }));
    await utimes(path, longAgo, longAgo);
    let inside = 0;
    let most = 0;
    const waiter = () =>
      withLock(
        path,
        async () => {
          inside++;
          most = Math.max(most, inside);
          await sleep(15);
          inside--;
        },
        { waitMs: 10_000 },
      );
    await Promise.all(Array.from({ length: 12 }, waiter));
    expect(most).toBe(1);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("a long run keeps its lock", () => {
  it("touches the lock while held, so it never looks stale", async () => {
    const path = join(dir, "a.lock");
    const lock = await takeLock(path, { staleMs: 300, heartbeatMs: 30 });
    await sleep(700); // well past staleMs
    expect(await takeLock(path, { staleMs: 300 })).toBeNull();
    await lock?.release();
    expect(await takeLock(path, { staleMs: 300 })).not.toBeNull();
  });

  it("without the touching, the same lock is taken over", async () => {
    const path = join(dir, "a.lock");
    await takeLock(path, { staleMs: 300, heartbeatMs: 60_000 });
    await sleep(500);
    expect(await takeLock(path, { staleMs: 300 })).not.toBeNull();
  });
});

describe("letting go when the process is told to quit", () => {
  it("releaseHeldLocks removes every lock this process holds", async () => {
    const a = join(dir, "a.lock");
    const b = join(dir, "b.lock");
    await takeLock(a);
    await takeLock(b);
    releaseHeldLocks();
    expect(await readdir(dir)).toEqual([]);
    expect(await takeLock(a)).not.toBeNull();
  });

  it("leaves a lock that's no longer ours", async () => {
    const path = join(dir, "a.lock");
    await takeLock(path, { staleMs: 1000 });
    await writeFile(path, JSON.stringify({ pid: 1, token: "someone-else" }));
    releaseHeldLocks();
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ token: "someone-else" });
  });
});
