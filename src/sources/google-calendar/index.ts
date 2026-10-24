import { z } from "zod";
import { type GoogleCredentials, loadGoogleCredentials } from "../../config/credentials";
import type { Activity, Attendance } from "../../core/types";
import type { Detected, Source } from "../types";
import { accessToken, type Fetch, GOOGLE_DOCS, googleClient } from "./oauth";

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
      const client = googleClient(ctx.config, ctx.env);
      // A refresh token only works with the client it was issued to.
      if (creds.client_id !== client.client_id)
        throw new Error(
          "Google Calendar: you connected with a different sign-in client than the one set up now. Run `clockout connect google` again.",
          { cause: new Error("stored client_id differs from the configured client") },
        );
      const token = await accessToken(client, creds.refresh_token, doFetch);
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
            (err: unknown) => {
              throw new Error(
                "Google Calendar: couldn't reach Google. Check your connection and try again.",
                { cause: err },
              );
            },
          );
          if (!res.ok)
            throw eventsError(res.status, await res.json().catch(() => null), calendarId);
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

/** Google's JSON error: `error.message`, and reasons in `errors[]` or `details[]`. */
const apiError = z.object({
  error: z.object({
    message: z.string().optional(),
    status: z.string().optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

/** A refused events request, with what to do about it. */
export function eventsError(status: number, json: unknown, calendarId: string): Error {
  const parsed = apiError.safeParse(json);
  const e = parsed.success ? parsed.data.error : undefined;
  const reasons = new Set(
    [...(e?.errors ?? []), ...(e?.details ?? [])].flatMap((x) => (x.reason ? [x.reason] : [])),
  );
  const said = e?.message ?? "";
  const cause = new Error(
    `HTTP ${status}${reasons.size ? ` [${[...reasons].join(", ")}]` : ""}${said ? `: ${said}` : ""}`,
  );
  const fail = (msg: string) => new Error(`Google Calendar: ${msg}`, { cause });
  const any = (...r: string[]) => r.some((x) => reasons.has(x));

  if (status === 401)
    return fail("Google no longer accepts the sign-in. Run `clockout connect google` again.");
  if (any("accessNotConfigured", "SERVICE_DISABLED"))
    return fail(
      "the Google Calendar API is off for your Cloud project. Turn it on at https://console.cloud.google.com/apis/library/calendar-json.googleapis.com, wait a minute, and try again.",
    );
  if (any("insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"))
    return fail(
      'calendar access wasn\'t allowed when you signed in. Run `clockout connect google` again and tick "View events on all your calendars".',
    );
  if (status === 429 || any("rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"))
    return fail("Google is limiting requests right now. Try again in a minute.");
  if (status === 404) return fail(`no calendar "${calendarId}" on this account.`);
  if (status === 403)
    return fail(
      `Google refused to list your events${said ? ` (${said})` : ""}. See Troubleshooting in ${GOOGLE_DOCS}.`,
    );
  return fail(`request failed (HTTP ${status}${said ? `: ${said}` : ""}). Try again shortly.`);
}

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
