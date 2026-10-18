import ical, { type Attendee, type VEvent } from "node-ical";
import type { Activity, Attendance } from "../../core/types";
import type { Detected, Source } from "../types";

export interface CalendarConfig {
  type: "calendar";
  method: "ics";
  url: string;
}

export type IcsFetcher = (url: string) => Promise<string>;

/** Downloads the feed. Errors never include the URL: it's a secret. */
export async function fetchIcs(url: string): Promise<string> {
  const res = await fetch(url.replace(/^webcal:/, "https:"), {
    signal: AbortSignal.timeout(20_000),
  }).catch((err: Error) => {
    throw new Error(`Calendar: couldn't reach the calendar feed (${err.name})`);
  });
  if (!res.ok) {
    throw new Error(
      `Calendar: the feed returned HTTP ${res.status}. If you reset the secret address, run \`clockout init\` again.`,
    );
  }
  return res.text();
}

export function createCalendarSource(fetcher: IcsFetcher = fetchIcs): Source<CalendarConfig> {
  return {
    id: "calendar",
    name: "Calendar",
    // A feed URL lives only in config; there's nothing to find on disk.
    detect: async (): Promise<Detected | null> => null,
    async *collect(range, cfg, ctx) {
      const me = ctx.config.me.emails.map((e) => e.toLowerCase());
      const data = ical.parseICS(await fetcher(cfg.url));
      for (const item of Object.values(data)) {
        if (!item || item.type !== "VEVENT" || item.status === "CANCELLED") continue;
        const instances = ical.expandRecurringEvent(item, {
          from: range.from,
          to: range.to,
          expandOngoing: true,
        });
        for (const inst of instances) {
          if (inst.isFullDay || inst.event.status === "CANCELLED") continue;
          const start = new Date(inst.start.getTime());
          const end = new Date(inst.end.getTime());
          if (!(start < range.to && end > range.from) || end <= start) continue;
          const others = attendeeEmails(inst.event).filter((e) => !me.includes(e));
          const a: Activity = {
            source: "calendar",
            kind: "meeting",
            actor: "human",
            start,
            end,
            title: text(inst.summary) || "(no title)",
            attendance: attendanceFor(inst.event, me),
            refs: [`event:${inst.event.uid}`],
          };
          if (others.length) a.attendees = others;
          yield a;
        }
      }
    },
  };
}

export const calendar = createCalendarSource();

/** Your RSVP. Events with no guest list are your own blocks, so they count as accepted. */
export function attendanceFor(event: VEvent, me: string[]): Attendance {
  const attendees = list(event.attendee);
  if (attendees.length === 0) return "accepted";
  const mine = attendees.find((a) => me.includes(emailOf(a)));
  if (!mine) return me.includes(emailOf(event.organizer)) ? "accepted" : "unknown";
  const stat = typeof mine === "object" ? mine.params?.PARTSTAT : undefined;
  switch (stat) {
    case "ACCEPTED":
      return "accepted";
    case "TENTATIVE":
      return "tentative";
    case "DECLINED":
      return "declined";
    case "NEEDS-ACTION":
      return "needs_action";
    default:
      return "unknown";
  }
}

function attendeeEmails(event: VEvent): string[] {
  return list(event.attendee).map(emailOf).filter(Boolean);
}

function list(a: Attendee | Attendee[] | undefined): Attendee[] {
  return a === undefined ? [] : Array.isArray(a) ? a : [a];
}

function emailOf(a: unknown): string {
  const v = text(a);
  return v.replace(/^mailto:/i, "").toLowerCase();
}

function text(v: unknown): string {
  if (typeof v === "string") return v;
  if (v && typeof v === "object" && "val" in v) return String((v as { val: unknown }).val ?? "");
  return "";
}
