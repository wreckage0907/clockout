import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange, localTime } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { createGoogleCalendarSource } from "../../src/sources/google-calendar";

const fixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`../fixtures/google/${name}`, import.meta.url), "utf8"));
const [page1, page2] = [
  await fixture("events-2026-10-16.page1.json"),
  await fixture("events-2026-10-16.page2.json"),
];

const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
  google: { client_id: "cid", client_secret: "secret" },
});
const ctx = { config, homeDir: "/home/dev", env: {} };
const creds = async () => ({ refresh_token: "rt", client_id: "cid", scope: "s", connected_at: "" });

function fakeGoogle() {
  const calls: string[] = [];
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      expect(String(init?.body)).toContain("grant_type=refresh_token");
      return Response.json({ access_token: "at", expires_in: 3600 });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer at");
    return Response.json(new URL(url).searchParams.get("pageToken") === "p2" ? page2 : page1);
  }) as typeof fetch;
  return { doFetch, calls };
}

describe("google-calendar source", () => {
  it("reads every page of the day's events with your RSVP from the self attendee", async () => {
    const { doFetch, calls } = fakeGoogle();
    const source = createGoogleCalendarSource({ fetch: doFetch, credentials: creds });
    const out: Activity[] = [];
    for await (const a of source.collect(
      dayRange("2026-10-16", "Asia/Kolkata"),
      { type: "google-calendar", calendars: ["primary"] },
      ctx,
    )) {
      out.push(a);
    }
    expect(
      out.map((a) => `${localTime(a.start, "Asia/Kolkata")} ${a.title} [${a.attendance}]`),
    ).toEqual([
      "09:30 Daily standup [accepted]",
      "15:00 Design sync [tentative]",
      "17:00 Vendor demo [declined]",
      "17:30 Focus: write release notes [unknown]",
      "18:00 Acme weekly sync [needs_action]",
    ]);
    expect(out[0]?.attendees).toEqual(["sam@example.com", "lead@example.com"]); // no you, no rooms
    expect(out[0]?.refs).toEqual(["event:standup@google.com"]); // same id as the ICS feed, so no double counting
    const list = calls.filter((c) => c.includes("/calendars/primary/events"));
    expect(list).toHaveLength(2);
    expect(new URL(list[0] as string).searchParams.get("timeMin")).toBe("2026-10-15T18:30:00.000Z");
    expect(new URL(list[0] as string).searchParams.get("singleEvents")).toBe("true");
  });

  it("explains when you haven't connected", async () => {
    const source = createGoogleCalendarSource({ credentials: async () => null });
    const run = async () => {
      for await (const _ of source.collect(
        dayRange("2026-10-16", "Asia/Kolkata"),
        { type: "google-calendar", calendars: ["primary"] },
        ctx,
      )) {
      }
    };
    await expect(run()).rejects.toThrow("Run `clockout connect google`");
  });
});
