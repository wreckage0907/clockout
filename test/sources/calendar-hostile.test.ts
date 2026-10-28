import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { createCalendarSource, fetchIcs } from "../../src/sources/calendar";

const hostile = await readFile(new URL("../fixtures/ics/hostile.ics", import.meta.url), "utf8");
const normal = await readFile(new URL("../fixtures/ics/calendar.ics", import.meta.url), "utf8");
const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
});
const ctx = { config, homeDir: "/home/dev", env: {} };
const cfg = {
  type: "calendar" as const,
  method: "ics" as const,
  url: "https://cal.example/secret.ics",
};

async function run(date: string, warn?: (m: string) => void) {
  const source = createCalendarSource(async () => hostile);
  const out: Activity[] = [];
  for await (const a of source.collect(dayRange(date, "Asia/Kolkata"), cfg, {
    ...ctx,
    ...(warn ? { warn } : {}),
  }))
    out.push(a);
  return out;
}

describe("calendar source with hostile invites", () => {
  it("skips events that repeat every second or minute or can't be read, keeps the rest, warns once", async () => {
    const warnings: string[] = [];
    const out = await run("2026-10-16", (m) => warnings.push(m));
    const titles = new Set(out.map((a) => a.title));
    expect(titles).toContain("Planning");
    expect(titles).not.toContain("Everything is urgent");
    expect(titles).not.toContain("Ping");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/skipped \d+ events?/);
  });

  it("keeps at most 48 instances of one event in a day", async () => {
    const out = await run("2026-10-16");
    expect(out.filter((a) => a.title === "Five-minute slots")).toHaveLength(48);
    expect(out.filter((a) => a.title === "Hourly check-in").length).toBeLessThanOrEqual(48);
    expect(out.length).toBeLessThan(120);
  });
});

describe("calendar feed size", () => {
  async function serve(handler: Parameters<typeof createServer>[1]) {
    const server = createServer(handler);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}/secret.ics`, close: () => server.close() };
  }

  it("refuses a local file over 10 MB", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clockout-ics-"));
    try {
      const file = join(dir, "big.ics");
      await writeFile(file, `BEGIN:VCALENDAR\n${"x".repeat(11 * 1024 * 1024)}\nEND:VCALENDAR\n`);
      await expect(fetchIcs(pathToFileURL(file).href)).rejects.toThrow(/larger than 10 MB/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("refuses a feed that declares more than 10 MB, and one that keeps sending", async () => {
    const declared = await serve((_req, res) => {
      res.writeHead(200, { "content-length": String(20 * 1024 * 1024) });
      res.write("BEGIN:VCALENDAR\n");
      setTimeout(() => res.destroy(), 200);
    });
    const chunk = Buffer.alloc(1024 * 1024, "x");
    const endless = await serve((_req, res) => {
      res.writeHead(200);
      let n = 0;
      const send = () => {
        while (n++ < 50) if (!res.write(chunk)) return void res.once("drain", send);
        res.end();
      };
      send();
    });
    try {
      await expect(fetchIcs(declared.url)).rejects.toThrow(/larger than 10 MB/);
      const err = await fetchIcs(endless.url).catch((e: Error) => e);
      expect((err as Error).message).toMatch(/larger than 10 MB/);
      expect((err as Error).message).not.toMatch(/secret/);
    } finally {
      declared.close();
      endless.close();
    }
  });

  it("still reads a normal feed over HTTP", async () => {
    const ok = await serve((_req, res) => res.end(normal));
    try {
      expect(await fetchIcs(ok.url)).toBe(normal);
    } finally {
      ok.close();
    }
  });
});
