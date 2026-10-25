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
  /** Project folders (names inside projects_dir) to leave out, e.g. personal ones. */
  exclude: z.array(z.string().min(1)).optional(),
});

const piSource = z.object({
  type: z.literal("pi"),
  /** Defaults to $PI_CODING_AGENT_DIR/sessions or ~/.pi/agent/sessions. */
  sessions_dir: z.string().optional(),
});

const codexSource = z.object({
  type: z.literal("codex"),
  /** Defaults to $CODEX_HOME/sessions or ~/.codex/sessions. */
  sessions_dir: z.string().optional(),
});

const opencodeSource = z.object({
  type: z.literal("opencode"),
  /** Defaults to $XDG_DATA_HOME/opencode/opencode.db or ~/.local/share/opencode/opencode.db. */
  db: z.string().optional(),
});

const antigravitySource = z.object({
  type: z.literal("antigravity"),
  /** The Antigravity CLI's folder; defaults to ~/.gemini/antigravity-cli. */
  dir: z.string().optional(),
});

const githubSource = z.object({
  type: z.literal("github"),
});

const calendarSource = z.object({
  type: z.literal("calendar"),
  method: z.literal("ics"),
  url: z.url({
    protocol: /^(https|webcal|file)$/,
    error:
      "use the https:// address of your private calendar feed (or a file:// path to an .ics file)",
  }),
});

const googleCalendarSource = z.object({
  type: z.literal("google-calendar"),
  /** Calendar ids; "primary" is your own. Connect with `clockout connect google`. */
  calendars: z.array(z.string().min(1)).min(1).default(["primary"]),
});

export const sourceConfig = z.discriminatedUnion("type", [
  claudeCodeSource,
  piSource,
  codexSource,
  opencodeSource,
  antigravitySource,
  githubSource,
  calendarSource,
  googleCalendarSource,
]);

/**
 * A project: how matching work is named (`match`), a project to leave out (`ignore`), or with
 * only a name, one you log time to by hand (offered in "Add time" and to the AI).
 */
const projectRule = z.object({
  name: z.string().min(1),
  /** Default task for this project's work blocks. */
  task: z.string().min(1).optional(),
  /**
   * Leave this project off the day, work and meetings, e.g. a personal one. Without `match`
   * it leaves out the project with this name, however it was found.
   */
  ignore: z.boolean().optional(),
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
    )
    .optional(),
});

/** Which ERP task a Clockout project (and optionally task) goes to. */
const taskMapping = z.object({
  project: z.string().min(1),
  /** Only rows with this task; leave out to match every row of the project. */
  task: z.string().min(1).optional(),
  /** The ERP's task id, e.g. "TASK-2026-00088". */
  erp_task: z.string().min(1),
  /** The ERP task's name, for display. */
  label: z.string().optional(),
});

/** https, or plain http only on this machine (a local test site). */
export function isSafeSite(url: string): boolean {
  const { protocol, hostname } = new URL(url);
  return (
    protocol === "https:" ||
    (protocol === "http:" &&
      (hostname === "localhost" || hostname.endsWith(".localhost") || hostname === "127.0.0.1"))
  );
}

const siteUrl = z
  .url({ protocol: /^https?$/, error: "use the site's address, e.g. https://erp.example.com" })
  .refine(isSafeSite, "use https:// (plain http only works for a site on this machine)");

const nextPmsTarget = z.object({
  type: z.literal("next-pms"),
  url: siteUrl,
  map: z.array(taskMapping).default([]),
});

/** Any timesheet or PMS system speaking Clockout's small JSON API (docs/timesheet-api.md). */
const httpTarget = z.object({
  type: z.literal("http"),
  /** The API's base address, e.g. "https://pms.example.com/api/clockout". */
  url: siteUrl,
  /** The environment variable holding the API token; the token itself never goes in this file. */
  token_env: z
    .string()
    .regex(/^[A-Z_][A-Z0-9_]*$/, "an environment variable name, e.g. CLOCKOUT_TIMESHEET_TOKEN")
    .default("CLOCKOUT_TIMESHEET_TOKEN"),
  map: z.array(taskMapping).default([]),
});

/** Names `clockout connect` already uses for something else. */
export const RESERVED_SERVER_NAMES = ["google", "erp"];

/** A remote MCP server (streamable HTTP), connected with `clockout connect <name>`. */
export const mcpServer = z.object({
  /** How you refer to it: `clockout connect wispr`. */
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/, "use a short lowercase name, e.g. wispr or notion")
    .refine((n) => !RESERVED_SERVER_NAMES.includes(n), "google and erp are taken; choose another"),
  /** The server's MCP endpoint, e.g. "https://api.example.com/mcp". */
  url: z
    .url({ protocol: /^https?$/, error: "use the server's address, e.g. https://example.com/mcp" })
    .refine(isSafeSite, "use https:// (plain http only works for a server on this machine)"),
});
export type McpServer = z.output<typeof mcpServer>;

export const timesheetTarget = z.discriminatedUnion("type", [nextPmsTarget, httpTarget]);

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
      /** Hours you aim to log in a day; the review screen fills towards it. */
      target: duration.default("8h"),
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
  /** Your own Google OAuth client (see docs/google-setup.md); overrides the built-in one. */
  google: z
    .object({
      client_id: z.string().min(1).optional(),
      client_secret: z.string().min(1).optional(),
    })
    .optional(),
  ai: z
    .object({
      /** "auto" uses the first installed of Claude Code, Codex, opencode and Pi. */
      backend: z.enum(["auto", "claude-code", "codex", "opencode", "pi", "none"]).default("auto"),
      /**
       * Model for the helper; leave out for its default (haiku for Claude Code, your own default
       * in the others). A Claude model only goes to Claude Code, any other only to the rest.
       */
      model: z.string().min(1).optional(),
    })
    .prefault({}),
  /** How the AI writes each row's description. Without the AI, titles are used as they are. */
  descriptions: z
    .object({
      /** "Fix …" (imperative), "Fixed …" (past) or "Fixing …" (continuous). */
      format: z.enum(["imperative", "past", "continuous"]).default("imperative"),
      /** short: 3–8 words; medium: one sentence; long: one or two sentences. */
      length: z.enum(["short", "medium", "long"]).default("short"),
      /** Your own prompt for the AI: how descriptions should read, e.g. "put the ticket key first". */
      instructions: z.string().min(1).max(2000).optional(),
      /** Descriptions you've written before; the AI matches their style. */
      examples: z.array(z.string().min(1).max(200)).max(5).optional(),
    })
    .prefault({}),
  sources: z.array(sourceConfig).default([]),
  projects: z.array(projectRule).default([]),
  /** MCP servers Clockout can sign in to and call ([ADR 0010](../../docs/adr/0010-mcp-as-source-and-destination.md)). */
  mcp: z
    .array(mcpServer)
    .refine(
      (servers) => new Set(servers.map((s) => s.name)).size === servers.length,
      "each MCP server needs its own name",
    )
    .default([]),
  /** Where `clockout push` sends the day. Connect with `clockout connect erp <url>`. */
  timesheet: timesheetTarget.optional(),
});

/** Config as written in config.toml (defaults optional). */
export type ConfigInput = z.input<typeof configSchema>;
/** Config after validation, with defaults filled in. */
export type Config = z.output<typeof configSchema>;
export type SourceConfig = z.output<typeof sourceConfig>;
export type TimesheetTarget = z.output<typeof timesheetTarget>;
export type TaskMapping = z.output<typeof taskMapping>;
export type DescriptionStyle = Config["descriptions"];

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
