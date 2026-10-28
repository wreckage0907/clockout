import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import {
  createGoogleCalendarSource,
  MAX_MEETINGS_PER_DAY,
} from "../../src/sources/google-calendar";

const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
  google: { client_id: "cid", client_secret: "secret" },
});
const creds = async () => ({ refresh_token: "rt", client_id: "cid", scope: "s", connected_at: "" });

/** Pages of 250 one-minute events, as many as asked, each linking to the next. */
function flood(pages: number) {
  let requests = 0;
  const doFetch = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    if (url.hostname === "oauth2.googleapis.com")
      return Response.json({ access_token: "at", expires_in: 3600 });
    requests++;
    const page = Number(url.searchParams.get("pageToken") ?? 0);
    const items = Array.from({ length: 250 }, (_, i) => {
      const minute = page * 250 + i;
      const at = (m: number) => new Date(Date.UTC(2026, 9, 16, 0, 0) + m * 60_000).toISOString();
      return {
        id: `spam${minute}`,
        summary: `Ping ${minute}`,
        start: { dateTime: at(minute) },
        end: { dateTime: at(minute + 1) },
      };
    });
    return Response.json({
      items,
      ...(page + 1 < pages ? { nextPageToken: String(page + 1) } : {}),
    });
  }) as typeof fetch;
  return { doFetch, requests: () => requests };
}

describe("google-calendar source with a flooded calendar", () => {
  it("stops at the per-day cap, warns, and stops asking for pages", async () => {
    const { doFetch, requests } = flood(100);
    const warnings: string[] = [];
    const source = createGoogleCalendarSource({ fetch: doFetch, credentials: creds });
    const out: Activity[] = [];
    for await (const a of source.collect(
      dayRange("2026-10-16", "Asia/Kolkata"),
      { type: "google-calendar", calendars: ["primary"] },
      { config, homeDir: "/home/dev", env: {}, warn: (m) => warnings.push(m) },
    ))
      out.push(a);
    expect(out).toHaveLength(MAX_MEETINGS_PER_DAY);
    expect(requests()).toBe(3);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/more than 500 events/);
  });
});
