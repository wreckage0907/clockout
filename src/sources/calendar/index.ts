import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import ical, { type Attendee, type CalendarComponent, type VEvent } from "node-ical";
import type { Activity, Attendance } from "../../core/types";
import type { Detected, Source } from "../types";

export interface CalendarConfig {
  type: "calendar";
  method: "ics";
  url: string;
}

export type IcsFetcher = (url: string) => Promise<string>;

/** A calendar of meetings is far below this; a bigger feed is a mistake or an attack. */
export const MAX_FEED_BYTES = 10 * 1024 * 1024;
/** Most instances of one event kept for a day (an hourly event is 24). */
export const MAX_INSTANCES_PER_EVENT = 48;
/** Most meetings kept for a day. */
export const MAX_MEETINGS_PER_DAY = 500;

const tooBig = () =>
  new Error(
    "Calendar: the calendar feed is larger than 10 MB, which is too big for a calendar. Check that the address is your calendar's iCal feed.",
  );

/** The body as text, stopping at the size limit instead of buffering what a server keeps sending. */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (declared > MAX_FEED_BYTES) {
    await res.body?.cancel().catch(() => undefined);
    throw tooBig();
  }
  if (!res.body) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of res.body) {
    size += chunk.byteLength;
    if (size > MAX_FEED_BYTES) {
      await res.body.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Downloads the feed. Errors never include the URL: it's a secret. */
export async function fetchIcs(url: string): Promise<string> {
  if (url.startsWith("file:")) {
    const file = fileURLToPath(url);
    const size = await stat(file).then(
      (st) => st.size,
      () => 0,
    );
    if (size > MAX_FEED_BYTES) throw tooBig();
    return readFile(file, "utf8").catch(() => {
      throw new Error("Calendar: couldn't read the local .ics file");
    });
  }
  const failed = (err: unknown) => {
    const e = err as Error & { cause?: { code?: string } };
    return new Error(
      e.name === "TimeoutError"
        ? "Calendar: the calendar feed didn't answer within 20 seconds. Check your connection and try again."
        : "Calendar: couldn't reach the calendar feed. Check your connection, or that the address still works.",
      // Only the kind of failure: the message could hold the address.
      { cause: new Error([e.name, e.cause?.code].filter(Boolean).join(" ")) },
    );
  };
  const res = await fetch(url.replace(/^webcal:/, "https:"), {
    signal: AbortSignal.timeout(20_000),
  }).catch((err: unknown) => {
    throw failed(err);
  });
  if (!res.ok) {
    throw new Error(
      `Calendar: the feed returned HTTP ${res.status}. If you reset the secret address, run \`clockout init\` again.`,
    );
  }
  return readCapped(res).catch((err: unknown) => {
    if (err instanceof Error && err.message === tooBig().message) throw err;
    throw failed(err);
  });
}

/** A whole calendar, not a sign-in page or an expired link's HTML, nor one cut off halfway. */
export function checkIcs(text: string): string {
  if (!/^\s*BEGIN:VCALENDAR/i.test(text))
    throw new Error(
      "Calendar: the feed address didn't return a calendar (it may have expired). Copy the secret iCal address again and run `clockout init`.",
    );
  if (!/END:VCALENDAR\s*$/i.test(text))
    throw new Error("Calendar: the calendar feed was cut off. Try again in a moment.");
  return text;
}

export function createCalendarSource(fetcher: IcsFetcher = fetchIcs): Source<CalendarConfig> {
  return {
    id: "calendar",
    name: "Calendar",
    // A feed URL lives only in config; there's nothing to find on disk.
    detect: async (): Promise<Detected | null> => null,
    async *collect(range, cfg, ctx) {
      const me = ctx.config.me.emails.map((e) => e.toLowerCase());
      const parsed = parseFeed(checkIcs(await fetcher(cfg.url)));
      let skipped = parsed.skipped;
      let kept = 0;
      for (const item of parsed.items) {
        if (item?.type !== "VEVENT" || item.status === "CANCELLED") continue;
        // One invite can't break the calendar: a repeat rule that fires every second or minute
        // (a flood of meetings), or one the library can't expand, skips that event only.
        if (repeatsTooOften(item)) {
          skipped++;
          continue;
        }
        let instances: ReturnType<typeof ical.expandRecurringEvent>;
        try {
          instances = ical.expandRecurringEvent(item, {
            from: range.from,
            to: range.to,
            expandOngoing: true,
          });
        } catch {
          skipped++;
          continue;
        }
        let fromEvent = 0;
        for (const inst of instances) {
          if (inst.isFullDay || inst.event.status === "CANCELLED") continue;
          const start = new Date(inst.start.getTime());
          const end = new Date(inst.end.getTime());
          if (!(start < range.to && end > range.from) || end <= start) continue;
          if (fromEvent >= MAX_INSTANCES_PER_EVENT || kept >= MAX_MEETINGS_PER_DAY) {
            skipped++;
            break;
          }
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
          fromEvent++;
          kept++;
          yield a;
        }
      }
      if (skipped)
        ctx.warn?.(
          `Calendar: skipped ${skipped} event${skipped === 1 ? "" : "s"} that repeat every second or minute, can't be read, or are more than a day can hold.`,
        );
    },
  };
}

export const calendar = createCalendarSource();

/**
 * The feed's components. One event the parser rejects (a repeat rule it can't read) fails the
 * whole parse, so then each event is parsed alone, with the feed's time zones, and the bad ones
 * are counted and left out.
 */
export function parseFeed(text: string): { items: CalendarComponent[]; skipped: number } {
  try {
    return { items: defined(Object.values(ical.parseICS(text))), skipped: 0 };
  } catch {
    const events = text.match(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi) ?? [];
    const head = text
      .replace(/BEGIN:VEVENT[\s\S]*?END:VEVENT/gi, "")
      .replace(/END:VCALENDAR\s*$/i, "");
    const items: CalendarComponent[] = [];
    let skipped = 0;
    for (const ev of events) {
      try {
        items.push(...defined(Object.values(ical.parseICS(`${head}${ev}\r\nEND:VCALENDAR\r\n`))));
      } catch {
        skipped++;
      }
    }
    return { items, skipped };
  }
}

const defined = <T>(xs: (T | undefined)[]): T[] => xs.filter((x): x is T => x !== undefined);

/** A repeat rule by the second or minute: no real meeting does that, and it floods the day. */
function repeatsTooOften(event: VEvent): boolean {
  return /FREQ=(SECONDLY|MINUTELY)/i.test(String(event.rrule?.toString() ?? ""));
}

/**
 * Your RSVP. Events with no guest list are blocks on your own calendar (lunch, gym, focus time):
 * `unknown`, so you're asked whether they were work.
 */
export function attendanceFor(event: VEvent, me: string[]): Attendance {
  const attendees = list(event.attendee);
  if (attendees.length === 0) return "unknown";
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
