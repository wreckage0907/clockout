import { z } from "zod";
import { hasSecret } from "../core/secrets";
import {
  withAi,
  withClaudeExclude,
  withCopyDefault,
  withDay,
  withDescriptions,
  withExport,
  withMemory,
  withoutExport,
  withoutMemory,
  withSource,
  withStandup,
  withTaskMapping,
} from "./edit";
import { type Config, configSchema, EXPORT_FIELDS, HOURS_FORMATS } from "./schema";

/** How many things Clockout remembers at once (the config schema's limit). */
const MEMORY_LIMIT = 20;

// Settings changes said in the chat bar. The AI returns these operations; it never writes the
// config. They're applied here (pure), then the whole config is validated like config.toml is.
// Signing in and out are side effects, so they come back as effects for the caller to run.

const service = z.enum(["google", "erp"]).describe('"google" is the calendar, "erp" the timesheet');

const erpTask = z
  .object({
    op: z.literal("erp_task"),
    project: z.string().min(1).describe("A Clockout project, as in the day or known projects"),
    task: z.string().min(1).optional().describe("Only this task's rows; leave out for all"),
    search: z
      .string()
      .min(1)
      .describe('The ERP task\'s name as they said it, without words like "task"'),
  })
  .describe("Send a project's rows to an ERP task from now on");

const source = z
  .object({
    op: z.literal("source"),
    source: z.enum(["claude-code", "pi", "codex", "opencode", "antigravity", "github"]),
    on: z.boolean(),
  })
  .describe(
    "Read Claude Code, Pi, Codex, opencode or Antigravity sessions, or GitHub activity, or stop",
  );
const claudeProjects = z
  .object({
    op: z.literal("claude_projects"),
    names: z.array(z.string().min(1)).min(1).describe("Names from claude_projects"),
    on: z.boolean(),
  })
  .describe("Read these Claude Code projects (on) or leave them out (off)");
const day = z
  .object({
    op: z.literal("day"),
    target: z.string().optional().describe('Hours to log a day, e.g. "7h30m"'),
    working_hours: z.string().optional().describe('"HH:MM-HH:MM", e.g. "09:30-18:30"'),
    round_to: z.string().optional().describe('e.g. "15m"'),
    idle_cutoff: z
      .string()
      .optional()
      .describe('A pause longer than this ends a block, e.g. "20m"'),
  })
  .describe("Daily target, working hours, rounding, idle cutoff");
const timezone = z
  .object({ op: z.literal("timezone"), timezone: z.string().min(1) })
  .describe("The person's IANA time zone, e.g. Asia/Kolkata");
const taskNames = z
  .object({
    op: z.literal("task_names"),
    work: z.string().min(1).optional(),
    review: z.string().min(1).optional(),
    meeting: z.string().min(1).optional(),
  })
  .describe("Default task names by kind of block");
const HELPERS = ["claude-code", "opencode", "pi"] as const;
/** The agent CLIs that can be the AI helper, by config name. */
export const HELPER_NAMES: Record<(typeof HELPERS)[number], string> = {
  "claude-code": "Claude Code",
  opencode: "opencode",
  pi: "Pi",
};
const ai = z
  .object({
    op: z.literal("ai"),
    on: z.boolean(),
    helper: z.enum(HELPERS).optional().describe("Which agent CLI to use, when they name one"),
  })
  .describe("Turn the AI helper on or off, or pick which agent runs it");
const descriptions = z
  .object({
    op: z.literal("descriptions"),
    format: z
      .enum(["imperative", "past", "continuous"])
      .optional()
      .describe('"Fix …", "Fixed …" or "Fixing …"'),
    length: z
      .enum(["short", "medium", "long"])
      .optional()
      .describe("short: 3–8 words; medium: one sentence; long: one or two sentences"),
    instructions: z
      .string()
      .max(2000)
      .optional()
      .describe('Their own instructions, in their words; "" removes them'),
    examples: z
      .array(z.string().min(1).max(200))
      .max(5)
      .optional()
      .describe("Descriptions they wrote before, to match the style of; [] removes them"),
  })
  .describe("How the AI writes each timesheet row's description");
const standup = z
  .object({
    op: z.literal("standup"),
    format: z
      .enum(["bullets", "prose"])
      .optional()
      .describe("bullets: a list per section; prose: a sentence or two per section"),
    length: z
      .enum(["short", "medium", "long"])
      .optional()
      .describe("short: up to 3 items of a few words; medium: up to 5 sentences; long: up to 8"),
    instructions: z
      .string()
      .max(2000)
      .optional()
      .describe('Their own instructions, in their words; "" removes them'),
    examples: z
      .array(z.string().min(1).max(1000))
      .max(3)
      .optional()
      .describe("Standups they wrote before, to match the style of; [] removes them"),
  })
  .describe("How the AI writes their standup");
const projectRule = z
  .object({
    op: z.literal("project_rule"),
    name: z.string().min(1).describe("The project name to use"),
    task: z.string().min(1).optional().describe("Default task for its work"),
    repo: z.string().optional().describe('"owner/name"'),
    title: z.string().optional().describe("Regular expression for meeting and session titles"),
    attendee_domain: z.string().optional().describe('e.g. "acme.com"'),
    ignore: z
      .boolean()
      .optional()
      .describe(
        "Leave matching work and meetings off the day; with no repo, title or domain, the project with this name",
      ),
  })
  .describe(
    "Add or replace a project: a rule that puts matching work under its name, one to leave out (ignore), or with only a name, a project they log time to by hand",
  );
const removeProjectRule = z
  .object({ op: z.literal("remove_project_rule"), name: z.string().min(1) })
  .describe("Remove the project (and its rules) with this name");
const exportFormat = z
  .object({
    op: z.literal("export_format"),
    name: z
      .string()
      .min(1)
      .describe('Short lowercase name, e.g. "harvest"; not csv, tsv, md, json'),
    type: z.enum(["csv", "tsv", "markdown", "json", "text"]),
    merge: z
      .boolean()
      .optional()
      .describe("false for one row per block of time; leave out to merge the same work"),
    columns: z
      .array(
        z.object({
          field: z.enum(EXPORT_FIELDS),
          header: z.string().optional().describe("The column's title, as they name it"),
          format: z
            .string()
            .optional()
            .describe(
              `Dates: a pattern of yyyy yy MMMM MMM MM M dd d EEEE EEE, e.g. "dd/MM/yyyy". Hours: ${HOURS_FORMATS.join(", ")} (hm is "1h 15m")`,
            ),
          decimals: z.number().int().optional().describe("Hours as decimal: places, 0–4"),
        }),
      )
      .optional()
      .describe("In order; leave out for date, project, task, hours, description"),
    line: z
      .string()
      .optional()
      .describe('Text only: one line per row, e.g. "{project}: {description} ({hours})"'),
    default: z.boolean().optional().describe("What Ctrl+Y and a bare /copy use"),
    to: z
      .object({
        mcp: z.string().min(1).describe("A server from [[mcp]]"),
        tool: z.string().min(1).describe("A tool from that server's tools"),
        arguments: z
          .record(z.string(), z.string())
          .optional()
          .describe("Templates: {text} is the export, {date} the day"),
      })
      .optional()
      .describe("Also send it to a connected MCP server; files are set by hand"),
  })
  .describe(
    "Add an export format, or replace the one with this name (send it whole, with what they asked to change)",
  );
const removeExport = z
  .object({ op: z.literal("remove_export"), name: z.string().min(1) })
  .describe("Remove the export format with this name");
const copyDefault = z
  .object({
    op: z.literal("copy_default"),
    name: z.string().describe('One of their exports, or "" for rows to paste'),
  })
  .describe("What Ctrl+Y and a bare /copy copy as");
const remember = z
  .object({
    op: z.literal("remember"),
    text: z.string().min(1).max(200).describe("It in their words, one line: what to keep in mind"),
  })
  .describe(
    "Keep something in mind for every description, standup and settings change. Only when no setting covers it (a rule, a style or a task name is a setting)",
  );
const forget = z
  .object({ op: z.literal("forget"), text: z.string().min(1) })
  .describe("Stop remembering something, by its words or part of them");
const connect = z
  .object({
    op: z.literal("connect"),
    service,
    url: z.string().optional().describe("The ERP's address, e.g. erp.example.com"),
  })
  .describe("Sign in in the browser: Google Calendar, or the ERP at an address");
const disconnect = z
  .object({ op: z.literal("disconnect"), service })
  .describe("Sign out and forget the sign-in");

/** What the AI may return. A private calendar link never reaches it, so no calendar_feed op. */
export const aiSettingOpSchema = z.discriminatedUnion("op", [
  source,
  claudeProjects,
  day,
  timezone,
  taskNames,
  ai,
  descriptions,
  standup,
  projectRule,
  removeProjectRule,
  exportFormat,
  removeExport,
  copyDefault,
  remember,
  forget,
  connect,
  disconnect,
  erpTask,
]);

export const settingOpSchema = z.discriminatedUnion("op", [
  source,
  claudeProjects,
  day,
  timezone,
  taskNames,
  ai,
  descriptions,
  standup,
  projectRule,
  removeProjectRule,
  exportFormat,
  removeExport,
  copyDefault,
  remember,
  forget,
  connect,
  disconnect,
  erpTask.extend({
    /** Filled in once the ERP has been searched. */
    erp_task: z.string().min(1).optional(),
    label: z.string().optional(),
  }),
  z.object({ op: z.literal("calendar_feed"), url: z.string().min(1) }),
]);
export type SettingOp = z.infer<typeof settingOpSchema>;
type SourceOp = z.infer<typeof source>;

/** Sign-ins and an ERP task still to choose: the caller does these. */
export type SettingEffect =
  | { kind: "connect"; service: "google" | "erp"; url?: string }
  | { kind: "disconnect"; service: "google" | "erp" }
  | { kind: "pick_task"; project: string; task?: string; search: string };

export interface ClaudeProjectRef {
  /** Folder name inside ~/.claude/projects, as `exclude` stores it. */
  folder: string;
  /** Short name, e.g. the repo folder. */
  name: string;
}

export interface SettingsResult {
  config: Config;
  effects: SettingEffect[];
  errors: string[];
}

/** Applies settings operations to a config; nothing is saved. `config` is valid on no errors. */
export function applySettings(
  config: Config,
  ops: readonly SettingOp[],
  projects: readonly ClaudeProjectRef[] = [],
): SettingsResult {
  let next = config;
  const effects: SettingEffect[] = [];
  const errors: string[] = [];
  for (const op of ops) {
    switch (op.op) {
      case "source":
        next = withSource(next, { type: op.source }, op.on);
        break;
      case "claude_projects": {
        const folders = op.names.flatMap((n) => {
          const found = projects.filter((p) => same(p.name, n) || p.folder === n);
          if (!found.length) errors.push(`No Claude Code project called “${n}”.`);
          return found.map((p) => p.folder);
        });
        if (!folders.length) break;
        if (op.on && !next.sources.some((s) => s.type === "claude-code"))
          next = withSource(next, { type: "claude-code" }, true);
        const claude = next.sources.find((s) => s.type === "claude-code");
        const excluded = claude?.type === "claude-code" ? (claude.exclude ?? []) : [];
        next = withClaudeExclude(
          next,
          op.on
            ? excluded.filter((f) => !folders.includes(f))
            : [...new Set([...excluded, ...folders])],
        );
        break;
      }
      case "day": {
        const { op: _, ...day } = op;
        next = withDay(next, defined(day));
        break;
      }
      case "timezone":
        next = { ...next, me: { ...next.me, timezone: op.timezone } };
        break;
      case "task_names": {
        const { op: _, ...tasks } = op;
        next = { ...next, tasks: { ...next.tasks, ...defined(tasks) } };
        break;
      }
      case "ai":
        next = withAi(next, op.on ? (op.helper ?? "auto") : "none");
        break;
      case "descriptions": {
        const { op: _, ...style } = op;
        next = withDescriptions(next, defined(style));
        break;
      }
      case "standup": {
        const { op: _, ...style } = op;
        next = withStandup(next, defined(style));
        break;
      }
      case "project_rule": {
        const match = {
          ...(op.repo ? { repo: op.repo } : {}),
          ...(op.title ? { title: op.title } : {}),
          ...(op.attendee_domain ? { attendee_domain: op.attendee_domain } : {}),
        };
        const rule = {
          name: op.name,
          ...(op.task ? { task: op.task } : {}),
          ...(op.ignore ? { ignore: true } : {}),
          ...(Object.keys(match).length ? { match } : {}),
        };
        const others = next.projects.filter(
          (p) => !(p.name === op.name && sameMatch(p.match, match)),
        );
        next = { ...next, projects: [...others, rule] };
        break;
      }
      case "remove_project_rule": {
        const left = next.projects.filter((p) => !same(p.name, op.name));
        if (left.length === next.projects.length)
          errors.push(`There's no project rule called “${op.name}”.`);
        next = { ...next, projects: left };
        break;
      }
      case "export_format": {
        // A program is code the person trusts; it's set by hand, never proposed (ADR 0009).
        if (op.to && "command" in (op.to as Record<string, unknown>)) {
          errors.push("A program as a destination is set by hand in config.toml, never from here.");
          break;
        }
        const { op: _, name, type, columns, ...rest } = op;
        // A file path is only ever set by hand, so an update keeps the one it already had.
        const had = next.exports.find((e) => e.name === name.trim().toLowerCase());
        const keep = !op.to && had?.to && "file" in had.to ? had.to : undefined;
        next = withExport(next, {
          ...defined(rest),
          ...(keep ? { to: keep } : {}),
          name: name.trim().toLowerCase(),
          type,
          // TOML has no undefined: leave out what wasn't said.
          ...(columns
            ? { columns: columns.map(({ field, ...c }) => ({ field, ...defined(c) })) }
            : {}),
        });
        break;
      }
      case "remove_export":
        if (!next.exports.some((e) => same(e.name, op.name)))
          errors.push(`There's no export called “${op.name}”.`);
        next = withoutExport(next, op.name.trim().toLowerCase());
        break;
      case "copy_default": {
        const name = op.name.trim().toLowerCase();
        if (name && !next.exports.some((e) => e.name === name)) {
          errors.push(
            `There's no export called “${op.name}”. Add one first (built-in formats can't be the default).`,
          );
          break;
        }
        next = withCopyDefault(next, name || undefined);
        break;
      }
      case "calendar_feed":
        next = {
          ...next,
          sources: [
            ...next.sources.filter((s) => s.type !== "calendar"),
            { type: "calendar", method: "ics", url: op.url },
          ],
        };
        break;
      case "remember": {
        const text = op.text.trim();
        // A memory is words, not a secret: a token-looking one is refused, not kept quietly.
        if (hasSecret(text)) {
          errors.push("That looks like a password or a token, so Clockout didn't remember it.");
          break;
        }
        if (next.memories.length >= MEMORY_LIMIT && !next.memories.some((m) => same(m, text))) {
          errors.push(
            `Clockout remembers ${MEMORY_LIMIT} things at most, and all ${MEMORY_LIMIT} are taken. Forget one first: ${next.memories.join(" · ")}`,
          );
          break;
        }
        next = withMemory(next, text);
        break;
      }
      case "forget": {
        const { config: after, forgotten } = withoutMemory(next, op.text);
        if (!forgotten) {
          errors.push(
            next.memories.length
              ? `There's no memory like “${op.text}”. Clockout remembers: ${next.memories.join(" · ")}`
              : "Clockout isn't remembering anything yet.",
          );
          break;
        }
        next = after;
        break;
      }
      case "connect":
        effects.push({ kind: "connect", service: op.service, ...(op.url ? { url: op.url } : {}) });
        break;
      case "disconnect":
        effects.push({ kind: "disconnect", service: op.service });
        break;
      case "erp_task":
        if (!next.timesheet && !effects.some((e) => e.kind === "connect" && e.service === "erp")) {
          errors.push("Connect your ERP first: say “connect my ERP at erp.example.com”.");
          break;
        }
        if (op.erp_task)
          next = withTaskMapping(next, {
            project: op.project,
            ...(op.task ? { task: op.task } : {}),
            erp_task: op.erp_task,
            ...(op.label ? { label: op.label } : {}),
          });
        else
          effects.push({
            kind: "pick_task",
            project: op.project,
            ...(op.task ? { task: op.task } : {}),
            search: op.search,
          });
        break;
    }
  }
  const valid = configSchema.safeParse(next);
  if (!valid.success)
    errors.push(
      ...valid.error.issues.map(
        (i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`,
      ),
    );
  return { config: valid.success ? valid.data : next, effects, errors };
}

/** How each description format starts, for display. */
export const FORMAT_WORDS = { imperative: "Fix", past: "Fixed", continuous: "Fixing" } as const;

const SOURCE_LABELS: Record<SourceOp["source"], string> = {
  "claude-code": "Claude Code sessions",
  pi: "Pi sessions",
  codex: "Codex sessions",
  opencode: "opencode sessions",
  antigravity: "Antigravity conversations",
  github: "GitHub",
};

/** One line per operation, for the proposal panel. */
export function describeSettings(ops: readonly SettingOp[]): string[] {
  return ops.map(describeSetting);
}

function describeSetting(op: SettingOp): string {
  const onOff = (on: boolean) => (on ? "Read" : "Stop reading");
  switch (op.op) {
    case "source":
      return `${onOff(op.on)} ${SOURCE_LABELS[op.source]}`;
    case "claude_projects":
      return `${op.on ? "Read" : "Leave out"} Claude Code project${op.names.length === 1 ? "" : "s"} ${op.names.join(", ")}`;
    case "day": {
      const parts = [
        op.target ? `daily target → ${op.target}` : "",
        op.working_hours ? `working hours → ${op.working_hours}` : "",
        op.round_to ? `round to ${op.round_to}` : "",
        op.idle_cutoff ? `idle cutoff → ${op.idle_cutoff}` : "",
      ].filter(Boolean);
      return parts.join(", ") || "No change to the day";
    }
    case "timezone":
      return `Time zone → ${op.timezone}`;
    case "task_names": {
      const parts = (["work", "review", "meeting"] as const)
        .filter((k) => op[k])
        .map((k) => `${k} task → ${op[k]}`);
      return parts.join(", ") || "No change to task names";
    }
    case "ai":
      if (!op.on) return "Turn the AI helper off";
      return op.helper
        ? `Use ${HELPER_NAMES[op.helper]} as the AI helper`
        : "Turn the AI helper on";
    case "descriptions": {
      const parts = [
        op.format ? `start with “${FORMAT_WORDS[op.format]} …”` : "",
        op.length ? `${op.length} length` : "",
        op.instructions === undefined
          ? ""
          : op.instructions.trim()
            ? `follow “${op.instructions.trim()}”`
            : "no instructions of your own",
        op.examples === undefined
          ? ""
          : op.examples.length
            ? `match ${op.examples.length} example${op.examples.length === 1 ? "" : "s"}`
            : "no examples",
      ].filter(Boolean);
      return parts.length ? `Descriptions: ${parts.join(", ")}` : "No change to descriptions";
    }
    case "standup": {
      const parts = [
        op.format ? (op.format === "prose" ? "a sentence or two each" : "bullet points") : "",
        op.length ? `${op.length} length` : "",
        op.instructions === undefined
          ? ""
          : op.instructions.trim()
            ? `follow “${op.instructions.trim()}”`
            : "no instructions of your own",
        op.examples === undefined
          ? ""
          : op.examples.length
            ? `match ${op.examples.length} example${op.examples.length === 1 ? "" : "s"}`
            : "no examples",
      ].filter(Boolean);
      return parts.length ? `Standup: ${parts.join(", ")}` : "No change to the standup";
    }
    case "project_rule": {
      const what = [
        op.repo ? `repo ${op.repo}` : "",
        op.title ? `titles like /${op.title}/` : "",
        op.attendee_domain ? `meetings with ${op.attendee_domain}` : "",
      ].filter(Boolean);
      if (op.ignore) return `Leave out ${what.join(", ") || op.name}, work and meetings`;
      if (!what.length) return `Add the project ${op.name}${op.task ? ` (${op.task})` : ""}`;
      return `${what.join(", ")} → project ${op.name}${op.task ? ` (${op.task})` : ""}`;
    }
    case "remove_project_rule":
      return `Remove the project ${op.name}`;
    case "export_format":
      return describeExport(op);
    case "remove_export":
      return `Remove the export ${op.name}`;
    case "copy_default":
      return op.name.trim()
        ? `Ctrl+Y copies as ${op.name.trim().toLowerCase()}`
        : "Ctrl+Y copies rows to paste";
    case "calendar_feed":
      return "Read your calendar from its private link (kept on this machine)";
    case "remember":
      return `Remember: “${op.text.trim()}”`;
    case "forget":
      return `Forget “${op.text.trim()}”`;
    case "connect":
      return op.service === "google"
        ? "Sign in to Google Calendar in your browser"
        : `Sign in to your ERP${op.url ? ` at ${op.url}` : ""} in your browser`;
    case "disconnect":
      return op.service === "google"
        ? "Sign out of Google Calendar and stop reading it"
        : "Sign out of your ERP";
    case "erp_task":
      return op.erp_task
        ? `Send ${op.project}${op.task ? ` · ${op.task}` : ""} rows to ${op.label ?? op.erp_task}`
        : `Pick the ERP task for ${op.project}${op.task ? ` · ${op.task}` : ""} (searching “${op.search}”)`;
  }
}

const TYPE_NAMES = { csv: "CSV", tsv: "TSV", markdown: "Markdown", json: "JSON", text: "Text" };

/** "Export harvest: CSV with Date (dd/MM/yyyy), Client project, Time (h:mm), Notes" */
function describeExport(op: z.infer<typeof exportFormat>): string {
  const column = (c: NonNullable<typeof op.columns>[number]) => {
    const how = c.format ?? (c.decimals !== undefined ? `${c.decimals} decimals` : "");
    return `${c.header ?? c.field}${how ? ` (${how})` : ""}`;
  };
  const what =
    op.type === "text"
      ? `lines like “${op.line ?? ""}”`
      : `${TYPE_NAMES[op.type]}${op.columns ? ` with ${op.columns.map(column).join(", ")}` : ""}`;
  const extras = [
    op.merge === false ? "one row per block" : "",
    op.default ? "what Ctrl+Y copies" : "",
  ].filter(Boolean);
  return `Export ${op.name.trim().toLowerCase()}: ${what}${extras.length ? ` · ${extras.join(" · ")}` : ""}`;
}

function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function sameMatch(
  a: Record<string, string | undefined> = {},
  b: Record<string, string | undefined> = {},
) {
  return (["repo", "title", "attendee_domain"] as const).every(
    (k) => (a[k] ?? "") === (b[k] ?? ""),
  );
}
