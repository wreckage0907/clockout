import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { describeError, logError } from "../src/log";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clockout-log-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("error log", () => {
  it("writes the message and its causes, with tokens redacted", async () => {
    const file = join(dir, "errors.log");
    const cause = new Error(
      "HTTP 401: Bad credentials for ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
    const err = new Error("GitHub: your gh login was rejected.", { cause });
    await logError("source github", err, file, new Date("2026-10-24T08:00:00Z"));
    expect(await readFile(file, "utf8")).toBe(
      "2026-10-24T08:00:00.000Z source github: GitHub: your gh login was rejected.\n  caused by: HTTP 401: Bad credentials for [redacted]\n",
    );
  });

  it("keeps the newer half when it grows too big", async () => {
    const file = join(dir, "errors.log");
    await writeFile(file, `${"old line\n".repeat(20_000)}${"new line\n".repeat(20_000)}`);
    await logError("x", new Error("latest"), file);
    const text = await readFile(file, "utf8");
    expect(text.length).toBeLessThan(200_000);
    expect(text.endsWith("x: latest\n")).toBe(true);
  });

  it("never throws, even when it can't write", async () => {
    await expect(
      logError("x", new Error("y"), "/dev/null/nope/errors.log"),
    ).resolves.toBeUndefined();
  });

  it("describes plain values too", () => {
    expect(describeError("just a string")).toBe("just a string");
  });
});
