import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { DayStore } from "../../src/store/json-store";

let dir: string;
let store: DayStore;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "clockout-store-"));
  await mkdir(join(dir, "days"));
  store = new DayStore(dir);
});

const put = (text: string) => writeFile(join(dir, "days", "2026-10-16.json"), text);

describe("day store", () => {
  it("says a damaged day file is damaged and how to rebuild it", async () => {
    await put('{"version": 1, "da');
    await expect(store.load("2026-10-16")).rejects.toThrow(
      /2026-10-16\.json is damaged\. Move it aside/,
    );
  });

  it("refuses to overwrite a day saved by a newer Clockout", async () => {
    await put('{"version": 2, "day": {}}');
    await expect(store.load("2026-10-16")).rejects.toThrow(/newer Clockout/);
  });

  it("refuses a file that isn't a saved day", async () => {
    await put("[]");
    await expect(store.load("2026-10-16")).rejects.toThrow(/isn't one Clockout can read/);
  });

  it("says when the day can't be saved", async () => {
    await chmod(join(dir, "days"), 0o500);
    const day = { version: 1, date: "2026-10-16", history: [] } as never;
    await expect(store.save(day)).rejects.toThrow(/Can't write the day to .*: permission denied/);
    await chmod(join(dir, "days"), 0o700);
  });
});
