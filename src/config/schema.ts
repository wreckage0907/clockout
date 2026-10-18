import { z } from "zod";

const clockTime = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "20m", "1h", "1h30m" */
export const durationPattern = /^(?:(\d+)h)?(?:(\d+)m)?$/;

const duration = z
  .string()
  .regex(durationPattern, { error: 'use a duration like "15m", "1h" or "1h30m"', abort: true })
  .refine((s) => s !== "" && durationMinutes(s) > 0, "must be longer than zero");

const timezone = z
  .string()
  .refine(isTimeZone, "unknown time zone; use an IANA name like Asia/Kolkata");

const workingHours = z
  .string()
  .regex(/^\d{2}:\d{2}-\d{2}:\d{2}$/, {
    error: 'use "HH:MM-HH:MM", e.g. "09:30-18:30"',
    abort: true,
  })
  .refine((s) => {
    const [from, to] = s.split("-") as [string, string];
    return clockTime.test(from) && clockTime.test(to) && from < to;
  }, "start must be a valid time before the end");

const claudeCodeSource = z.object({
  type: z.literal("claude-code"),
  /** Defaults to $CLAUDE_CONFIG_DIR/projects or ~/.claude/projects. */
  projects_dir: z.string().optional(),
});

const githubSource = z.object({
  type: z.literal("github"),
});

const calendarSource = z.object({
  type: z.literal("calendar"),
  method: z.literal("ics"),
  url: z.url({
    protocol: /^(https|webcal)$/,
    error: "use the https:// address of your private calendar feed",
  }),
});

export const sourceConfig = z.discriminatedUnion("type", [
  claudeCodeSource,
  githubSource,
  calendarSource,
]);

const projectRule = z.object({
  name: z.string().min(1),
  /** Default task for this project's work blocks. */
  task: z.string().min(1).optional(),
  match: z
    .object({
      /** "owner/name" */
      repo: z.string().optional(),
      /** Regular expression tested against meeting and session titles. */
      title: z.string().optional(),
      /** e.g. "acme.com": meetings with attendees from this domain. */
      attendee_domain: z.string().optional(),
    })
    .refine(
      (m) => m.repo || m.title || m.attendee_domain,
      "give at least one of repo, title, attendee_domain",
    ),
});

export const configSchema = z.object({
  me: z.object({
    name: z.string().min(1),
    /** Used to find your RSVP in calendar attendee lists. */
    emails: z.array(z.email()).min(1),
    /** Commit author emails or names; defaults to `emails`. */
    git_authors: z.array(z.string().min(1)).optional(),
    timezone,
  }),
  day: z
    .object({
      working_hours: workingHours.default("09:30-18:30"),
      idle_cutoff: duration.default("20m"),
      round_to: duration.default("15m"),
    })
    .prefault({}),
  /** Task names by kind of block; a project's own `task` wins for work blocks. */
  tasks: z
    .object({
      work: z.string().min(1).default("Development"),
      review: z.string().min(1).default("Code Review"),
      meeting: z.string().min(1).default("Meetings"),
    })
    .prefault({}),
  ai: z
    .object({
      backend: z.enum(["auto", "claude-code", "none"]).default("auto"),
      /** Model alias passed to the backend; small and fast is plenty. */
      model: z.string().min(1).default("haiku"),
    })
    .prefault({}),
  sources: z.array(sourceConfig).default([]),
  projects: z.array(projectRule).default([]),
});

/** Config as written in config.toml (defaults optional). */
export type ConfigInput = z.input<typeof configSchema>;
/** Config after validation, with defaults filled in. */
export type Config = z.output<typeof configSchema>;
export type SourceConfig = z.output<typeof sourceConfig>;

export function durationMinutes(s: string): number {
  const m = durationPattern.exec(s);
  if (!m) throw new Error(`invalid duration: ${s}`);
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
