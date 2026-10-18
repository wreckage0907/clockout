import { z } from "zod";
import { type GoogleCredentials, loadGoogleCredentials } from "../../config/credentials";
import type { Activity, Attendance } from "../../core/types";
import type { Detected, Source } from "../types";
import { accessToken, type Fetch, googleClient } from "./oauth";

export interface GoogleCalendarConfig {
  type: "google-calendar";
  calendars: string[];
}

const person = z.object({
  email: z.string().optional(),
  self: z.boolean().optional(),
  resource: z.boolean().optional(),
  responseStatus: z.string().optional(),
});
const when = z.object({ dateTime: z.string().optional(), date: z.string().optional() });
const event = z.object({
  id: z.string(),
  iCalUID: z.string().optional(),
  status: z.string().optional(),
  summary: z.string().optional(),
  eventType: z.string().optional(),
  start: when,
  end: when,
  attendees: z.array(person).optional(),
  organizer: person.optional(),
});
const page = z.object({
  items: z.array(z.unknown()).default([]),
  nextPageToken: z.string().optional(),
});

/** Not meetings: you're away, or it's a label on the day. */
const SKIP_TYPES = new Set(["outOfOffice", "workingLocation", "birthday"]);

export interface GoogleCalendarDeps {
  fetch?: Fetch;
  credentials?: () => Promise<GoogleCredentials | null>;
}

export function createGoogleCalendarSource(
  deps: GoogleCalendarDeps = {},
): Source<GoogleCalendarConfig> {
  const doFetch = deps.fetch ?? fetch;
  const credentials = deps.credentials ?? (() => loadGoogleCredentials());
  return {
    id: "google-calendar",
    name: "Google Calendar",
    detect: async (): Promise<Detected | null> => {
      const c = await credentials();
      return c ? { summary: `connected${c.email ? ` as ${c.email}` : ""}` } : null;
    },
    async *collect(range, cfg, ctx) {
      const creds = await credentials();
      if (!creds) throw new Error("Google Calendar: not connected. Run `clockout connect google`.");
      const token = await accessToken(
        googleClient(ctx.config, ctx.env),
        creds.refresh_token,
        doFetch,
      );
      for (const calendarId of cfg.calendars) {
        let pageToken: string | undefined;
        do {
          const q = new URLSearchParams({
            timeMin: range.from.toISOString(),
            timeMax: range.to.toISOString(),
            singleEvents: "true",
            orderBy: "startTime",
            maxResults: "250",
            ...(pageToken ? { pageToken } : {}),
          });
          const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events?${q}`;
          const res = await doFetch(url, { headers: { authorization: `Bearer ${token}` } }).catch(
            () => {
              throw new Error("Google Calendar: couldn't reach Google.");
            },
          );
          if (!res.ok) {
            throw new Error(
              res.status === 404
                ? `Google Calendar: no calendar "${calendarId}" on this account.`
                : `Google Calendar: request failed (HTTP ${res.status}).`,
            );
          }
          const body = page.parse(await res.json());
          for (const raw of body.items) {
            const parsed = event.safeParse(raw);
            if (parsed.success) {
              const a = toActivity(parsed.data);
              if (a) yield a;
            }
          }
          pageToken = body.nextPageToken;
        } while (pageToken);
      }
    },
  };
}

export const googleCalendar = createGoogleCalendarSource();

type Event = z.infer<typeof event>;

export function toActivity(e: Event): Activity | null {
  if (e.status === "cancelled" || SKIP_TYPES.has(e.eventType ?? "")) return null;
  // All-day events have `date` instead of `dateTime`.
  if (!e.start.dateTime || !e.end.dateTime) return null;
  const start = new Date(e.start.dateTime);
  const end = new Date(e.end.dateTime);
  if (!(end > start)) return null;
  const others = (e.attendees ?? [])
    .filter((p) => !p.self && !p.resource && p.email)
    .map((p) => (p.email as string).toLowerCase());
  const a: Activity = {
    source: "google-calendar",
    kind: "meeting",
    actor: "human",
    start,
    end,
    title: e.summary || "(no title)",
    attendance: attendanceOf(e),
    refs: [`event:${e.iCalUID ?? e.id}`],
  };
  if (others.length) a.attendees = others;
  return a;
}

/**
 * Your RSVP from the attendee marked `self`. Focus time and events with no guests are blocks on
 * your own calendar: `unknown`, so you're asked whether they were work.
 */
export function attendanceOf(e: Event): Attendance {
  if (e.eventType === "focusTime") return "unknown";
  const me = e.attendees?.find((p) => p.self);
  if (!me) {
    const guests = (e.attendees ?? []).filter((p) => !p.resource);
    return guests.length && e.organizer?.self ? "accepted" : "unknown";
  }
  switch (me.responseStatus) {
    case "accepted":
      return "accepted";
    case "tentative":
      return "tentative";
    case "declined":
      return "declined";
    case "needsAction":
      return "needs_action";
    default:
      return "unknown";
  }
}
