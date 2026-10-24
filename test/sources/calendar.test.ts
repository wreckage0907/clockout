import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange, localTime } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { describeError } from "../../src/log";
import { createCalendarSource, fetchIcs } from "../../src/sources/calendar";

const ics = await readFile(new URL("../fixtures/ics/calendar.ics", import.meta.url), "utf8");
const config = configSchema.parse({
  me: { name: "Dev", emails: ["Dev@Example.com"], timezone: "Asia/Kolkata" },
});
const ctx = { config, homeDir: "/home/dev", env: {} };
const cfg = {
  type: "calendar" as const,
  method: "ics" as const,
  url: "https://cal.example/secret.ics",
};

async function collect(date: string): Promise<Activity[]> {
  const source = createCalendarSource(async (url) => {
    expect(url).toBe(cfg.url);
    return ics;
  });
  const out: Activity[] = [];
  for await (const a of source.collect(dayRange(date, "Asia/Kolkata"), cfg, ctx)) out.push(a);
  return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

const row = (a: Activity) =>
  `${localTime(a.start, "Asia/Kolkata")}-${a.end ? localTime(a.end, "Asia/Kolkata") : "?"} ${a.title} [${a.attendance}]`;

describe("calendar source", () => {
  it("lists the day's timed meetings with your RSVP, skipping all-day events", async () => {
    expect((await collect("2026-10-16")).map(row)).toEqual([
      "09:30-10:00 Daily standup [accepted]",
      "15:00-15:30 Design sync [tentative]",
      "17:00-17:30 Vendor demo [declined]",
      "17:30-18:00 Focus: write release notes [unknown]",
      "18:00-18:30 Acme weekly sync [needs_action]",
    ]);
  });

  it("keeps other attendees for project rules, without you", async () => {
    const [standup] = await collect("2026-10-16");
    expect(standup).toMatchObject({
      kind: "meeting",
      actor: "human",
      attendees: ["sam@example.com", "lead@example.com"],
      refs: ["event:standup@google.com"],
    });
  });

  it("expands recurring meetings and honours cancelled occurrences", async () => {
    expect((await collect("2026-10-14")).map(row)).toEqual([
      "09:30-10:00 Daily standup [accepted]",
    ]);
    expect(await collect("2026-10-15")).toEqual([]);
    expect(await collect("2026-10-17")).toEqual([]); // Saturday
  });

  it("never puts the secret URL in errors", async () => {
    const source = createCalendarSource(async () => {
      throw new Error("Calendar: the feed returned HTTP 404.");
    });
    const run = async () => {
      for await (const _ of source.collect(dayRange("2026-10-16", "Asia/Kolkata"), cfg, ctx)) {
      }
    };
    await expect(run()).rejects.toThrow(/HTTP 404/);
    await expect(run()).rejects.not.toThrow(/secret/);
  });

  it("says when the feed isn't a calendar, or was cut off", async () => {
    const answer = (body: string) => async () => {
      const source = createCalendarSource(async () => body);
      for await (const _ of source.collect(dayRange("2026-10-16", "Asia/Kolkata"), cfg, ctx)) {
      }
    };
    await expect(answer("<html>Sign in</html>")()).rejects.toThrow(/didn't return a calendar/);
    await expect(answer("")()).rejects.toThrow(/didn't return a calendar/);
    await expect(answer(ics.slice(0, ics.length / 2))()).rejects.toThrow(/was cut off/);
  });

  it("says to check the connection when the feed can't be reached, without the address", async () => {
    const err = await fetchIcs("https://127.0.0.1:9/secret.ics").catch((e: Error) => e);
    expect((err as Error).message).toMatch(
      /couldn't reach the calendar feed\. Check your connection/,
    );
    expect(describeError(err)).not.toMatch(/secret/);
  });
});
