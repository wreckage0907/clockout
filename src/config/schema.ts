import { z } from "zod";
import { unsafePatternReason } from "../core/regex";

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

/**
 * Meetings you recorded (Wispr Flow's Notetaker, through its MCP server): read-only, named after
 * the `[[mcp]]` server it reads from ([ADR 0010](../../docs/adr/0010-mcp-as-source-and-destination.md)).
 */
const wisprFlowSource = z.object({
  type: z.literal("wispr-flow"),
  /** The `[[mcp]]` server to read; `clockout connect wispr` adds it. */
  server: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/, "an MCP server's name, e.g. wispr")
    .default("wispr"),
  /** The server's tool names, when they aren't the ones Clockout looks for. */
  tools: z
    .object({
      /** Lists meetings over a range. */
      list: z.string().min(1).optional(),
      /** Reads one meeting in full, when the list leaves out its summary. */
      meeting: z.string().min(1).optional(),
    })
    .optional(),
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
  wisprFlowSource,
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
      title: z
        .string()
        .superRefine((t, ctx) => {
          const why = unsafePatternReason(t);
          if (why) ctx.addIssue({ code: "custom", message: `the title pattern ${why}` });
        })
        .optional(),
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

/** Any timesheet or PMS system speaking Clockout's small JSON API (docs/timesheet-api.md). */
const httpTarget = z
  .object({
    type: z.literal("http"),
    /** The API's base address, e.g. "https://pms.example.com/api/clockout". */
    url: siteUrl,
    /**
     * The environment variable holding the API token (CLOCKOUT_TIMESHEET_TOKEN when neither this
     * nor `token` is given). Keeps the token out of this file.
     */
    token_env: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/, "an environment variable name, e.g. CLOCKOUT_TIMESHEET_TOKEN")
      .optional(),
    /**
     * The API token itself, for people who'd rather not manage an environment variable. Set by
     * hand only ([ADR 0013](../../docs/adr/0013-timesheet-systems-speak-one-api.md)): no settings
     * operation can set, change or read it, and it never goes to the AI.
     */
    token: z.string().min(1).regex(/^\S+$/, "a token has no spaces or line breaks").optional(),
    map: z.array(taskMapping).default([]),
  })
  .refine((t) => !(t.token && t.token_env), {
    path: ["token"],
    error: "use either token or token_env, not both",
  });

/** The environment variable an `http` target reads its token from unless told otherwise. */
export const DEFAULT_TOKEN_ENV = "CLOCKOUT_TIMESHEET_TOKEN";

/**
 * The escape hatch ([ADR 0009](../../docs/adr/0009-change-clockout-through-config.md), layer 4):
 * a program you name, given one JSON request on stdin and one JSON answer on stdout. Only ever
 * set by hand: no settings operation can add, change or point at one.
 */
const commandLine = z
  .array(z.string().min(1).max(1000))
  .min(1, 'give the program to run, e.g. ["my-pms", "--timesheet"]')
  .max(32);

const commandTarget = z.object({
  type: z.literal("command"),
  /** No shell: the first item is the program, the rest are its arguments, exactly as written. */
  run: commandLine,
  map: z.array(taskMapping).default([]),
});

/** Names `clockout connect` already uses for something else. */
export const RESERVED_SERVER_NAMES = ["google"];

/** A remote MCP server (streamable HTTP), connected with `clockout connect <name>`. */
export const mcpServer = z.object({
  /** How you refer to it: `clockout connect wispr`. */
  name: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/, "use a short lowercase name, e.g. wispr or notion")
    .refine((n) => !RESERVED_SERVER_NAMES.includes(n), "google is taken; choose another"),
  /** The server's MCP endpoint, e.g. "https://api.example.com/mcp". */
  url: z
    .url({ protocol: /^https?$/, error: "use the server's address, e.g. https://example.com/mcp" })
    .refine(isSafeSite, "use https:// (plain http only works for a server on this machine)"),
});
export type McpServer = z.output<typeof mcpServer>;

export const timesheetTarget = z.discriminatedUnion("type", [httpTarget, commandTarget]);

/** Where a target sends days, for display: the site's address, or the program it runs. */
export function targetWhere(t: TimesheetTarget): string {
  return t.type === "command" ? `\`${t.run.join(" ")}\`` : t.url;
}

/** A site target's host, for display; null for a command (nothing to sign in to). */
export function targetHost(t: TimesheetTarget | undefined): string | null {
  return t && t.type !== "command" ? new URL(t.url).host : null;
}

/** Names the built-in export formats use; an `[[exports]]` name can't take them. */
export const BUILT_IN_FORMATS = ["csv", "tsv", "md", "markdown", "json"] as const;

/** What a timesheet row offers an export. The ERP task is the row's own pick or its mapping. */
export const EXPORT_FIELDS = [
  "date",
  "project",
  "task",
  "hours",
  "description",
  "erp_task",
  "erp_task_name",
] as const;
export type ExportField = (typeof EXPORT_FIELDS)[number];

/** decimal: 1.25 · h:mm: 1:15 · minutes: 75 · hm: 1h 15m */
export const HOURS_FORMATS = ["decimal", "h:mm", "minutes", "hm"] as const;

/** Date pattern tokens: yyyy yy MMMM MMM MM M dd d EEEE EEE; anything else is kept as it is. */
export const DATE_TOKENS = /yyyy|yy|MMMM|MMM|MM|M|dd|d|EEEE|EEE/g;

const exportColumn = z
  .object({
    field: z.enum(EXPORT_FIELDS),
    /** The column's title; the field's name when left out. */
    header: z.string().max(80).optional(),
    /** Dates: a pattern like "dd/MM/yyyy". Hours: decimal, h:mm, minutes or hm. */
    format: z.string().min(1).max(40).optional(),
    /** Hours as decimal: places after the point (0–4, default 2). */
    decimals: z.number().int().min(0).max(4).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.format === undefined) {
      if (c.decimals !== undefined && c.field !== "hours")
        ctx.addIssue({ code: "custom", message: "decimals is only for hours" });
      return;
    }
    if (c.field === "hours") {
      if (!(HOURS_FORMATS as readonly string[]).includes(c.format))
        ctx.addIssue({
          code: "custom",
          path: ["format"],
          message: `hours are ${HOURS_FORMATS.join(", ")}`,
        });
      else if (c.decimals !== undefined && c.format !== "decimal")
        ctx.addIssue({ code: "custom", message: "decimals is only for hours as decimal" });
    } else if (c.field === "date") {
      if (!c.format.match(DATE_TOKENS))
        ctx.addIssue({
          code: "custom",
          path: ["format"],
          message: 'use a date pattern like "dd/MM/yyyy" or "yyyy-MM-dd"',
        });
    } else
      ctx.addIssue({
        code: "custom",
        path: ["format"],
        message: "only dates and hours have a format",
      });
  });

const LINE_FIELD = /\{([^{}]*)\}/g;

/**
 * Where an export goes besides the clipboard or the screen ([ADR 0010](../../docs/adr/0010-mcp-as-source-and-destination.md)):
 * a file (an Obsidian daily note) or one tool on a connected MCP server.
 */
const fileDestination = z.object({
  /** A path, `~` allowed. `{date}` is the day (or the range's last day). */
  file: z.string().min(1).max(400),
  /** Adds to the end of the file instead of replacing it. */
  append: z.boolean().optional(),
});
const mcpDestination = z.object({
  /** A server in `[[mcp]]`. */
  mcp: z
    .string()
    .regex(/^[a-z][a-z0-9-]{0,31}$/, "an MCP server's name, e.g. notion")
    .refine(
      (n) => !RESERVED_SERVER_NAMES.includes(n),
      "google isn't an MCP server; choose another",
    ),
  /** The tool to call; it comes from the server's own `tools/list`. */
  tool: z.string().min(1).max(120),
  /** Templates: `{text}` is the export, `{date}` the day. Nothing else. */
  arguments: z.record(z.string().max(60), z.string().max(4000)).optional(),
});
/** `{text}` and `{date}` are the only things filled in; nothing is evaluated. */
const DESTINATION_FIELD = /\{([^{}]*)\}/g;

const commandDestination = z.object({
  /** A program that takes `{ date, format, text }` and answers JSON. No shell. */
  command: commandLine,
});

const exportDestination = z
  .union([fileDestination, mcpDestination, commandDestination])
  .superRefine((d, ctx) => {
    const arg =
      "file" in d ? d.file : "command" in d ? "" : Object.values(d.arguments ?? {}).join(" ");
    for (const [, f] of arg.matchAll(DESTINATION_FIELD))
      if (f !== "text" && f !== "date")
        ctx.addIssue({
          code: "custom",
          message: `{${f}} isn't filled in; use {text} and {date}`,
        });
  });
export type ExportDestination = z.output<typeof exportDestination>;

/**
 * Your own export format ([ADR 0009](../../docs/adr/0009-change-clockout-through-config.md)):
 * named columns, or for text a line per row with `{field}`s filled in. Nothing is evaluated.
 */
export const exportFormat = z
  .object({
    /** How you ask for it: `clockout export -f harvest`, `/copy harvest`. */
    name: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,31}$/, "use a short lowercase name, e.g. harvest")
      .refine(
        (n) => !(BUILT_IN_FORMATS as readonly string[]).includes(n),
        `${BUILT_IN_FORMATS.join(", ")} are built in; choose another name`,
      ),
    type: z.enum(["csv", "tsv", "markdown", "json", "text"]),
    /** The same work in one row (true), or one row per block of time. */
    merge: z.boolean().default(true),
    /** Leave out for date, project, task, hours, description. A text export uses only their formats. */
    columns: z.array(exportColumn).min(1).max(20).optional(),
    /** Text exports: one line per row, e.g. "{project}: {description} ({hours})". */
    line: z.string().min(1).max(500).optional(),
    /** What Ctrl+Y, Copy sheet and a bare /copy use. */
    default: z.boolean().optional(),
    /** Where it's written as well, when you ask for it (`clockout export -f <name> --dest`). */
    to: exportDestination.optional(),
  })
  .superRefine((e, ctx) => {
    if (e.type === "text" && !e.line)
      ctx.addIssue({
        code: "custom",
        path: ["line"],
        message: 'a text export needs a line, e.g. "{project}: {description} ({hours})"',
      });
    if (e.type !== "text" && e.line)
      ctx.addIssue({ code: "custom", path: ["line"], message: "line is only for text exports" });
    for (const [, f] of e.line?.matchAll(LINE_FIELD) ?? [])
      if (!(EXPORT_FIELDS as readonly string[]).includes(f ?? ""))
        ctx.addIssue({
          code: "custom",
          path: ["line"],
          message: `{${f}} isn't a field; use ${EXPORT_FIELDS.map((x) => `{${x}}`).join(" ")}`,
        });
  });
export type ExportFormat = z.output<typeof exportFormat>;

/**
 * A job a scheduler runs for you ([ADR 0012](../../docs/adr/0012-let-a-scheduler-run-it.md)):
 * a standing confirmation, shown in full when it's added. Set by hand or with
 * `clockout schedule add`; no settings operation can add or point at one.
 */
export const scheduleJobSchema = z.object({
  /** How you refer to it, and the name of its OS unit: `clockout schedule remove <name>`. */
  name: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "use a short lowercase name, e.g. daily-note"),
  /** Local time on your clock, "HH:MM". */
  at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'use a 24-hour time like "18:30"'),
  /** The day it runs for: today (fresh, maybe unfinished) or yesterday (the finished sheet). */
  day: z.enum(["today", "yesterday"]).default("today"),
  /** `export` sends a named format to its destination; `standup` writes the standup there. */
  kind: z.enum(["export", "standup"]).default("export"),
  /** An `[[exports]]` name with a `to`; the standup uses its destination too. */
  format: z.string().min(1),
  /** Exit 0 even when the day still has open questions (a deliberate mid-afternoon run). */
  allow_open: z.boolean().default(false),
});
export type ScheduleJob = z.output<typeof scheduleJobSchema>;

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
      /** "auto" uses the first installed of Claude Code, opencode and Pi. */
      backend: z.enum(["auto", "claude-code", "opencode", "pi", "none"]).default("auto"),
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
  /** How the AI writes `clockout standup`. Without the AI, a plain template is used. */
  standup: z
    .object({
      /** bullets: a list under Yesterday, Today, Blockers; prose: a sentence or two for each. */
      format: z.enum(["bullets", "prose"]).default("bullets"),
      /** short: up to 3 items, a few words; medium: up to 5, a sentence; long: up to 8. */
      length: z.enum(["short", "medium", "long"]).default("short"),
      /** Your own prompt, e.g. "mention ticket keys, leave out meetings". */
      instructions: z.string().min(1).max(2000).optional(),
      /** Standups you've written before; the AI matches their style. */
      examples: z.array(z.string().min(1).max(1000)).max(3).optional(),
    })
    .prefault({}),
  /**
   * Things you told Clockout to remember, in your own words: what the AI writes descriptions and
   * standups with, and what no setting covers ([ADR 0011](../../docs/adr/0011-remember-what-people-say.md)).
   */
  memories: z
    .array(z.string().min(1).max(200))
    .max(20, "Clockout remembers 20 things at most; forget one first")
    .default([]),
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
  /** Where `clockout push` sends the day: set by hand in config.toml (docs/timesheet-api.md). */
  timesheet: timesheetTarget.optional(),
  /** Jobs a scheduler runs, installed as OS units by `clockout schedule sync`. */
  schedule: z
    .array(scheduleJobSchema)
    .refine(
      (all) => new Set(all.map((j) => j.name)).size === all.length,
      "each scheduled job needs its own name",
    )
    .default([]),
  /** Your own export formats, next to the built-in csv, tsv, md and json. */
  exports: z
    .array(exportFormat)
    .refine(
      (all) => new Set(all.map((e) => e.name)).size === all.length,
      "each export needs its own name",
    )
    .refine((all) => all.filter((e) => e.default).length <= 1, "only one export can be the default")
    .default([]),
});

/** Config as written in config.toml (defaults optional). */
export type ConfigInput = z.input<typeof configSchema>;
/** Config after validation, with defaults filled in. */
export type Config = z.output<typeof configSchema>;
export type SourceConfig = z.output<typeof sourceConfig>;
export type TimesheetTarget = z.output<typeof timesheetTarget>;
export type TaskMapping = z.output<typeof taskMapping>;
export type DescriptionStyle = Config["descriptions"];
export type StandupStyle = Config["standup"];

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
