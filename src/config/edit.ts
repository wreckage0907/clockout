import type { Config, ExportFormat, McpServer, SourceConfig, TaskMapping } from "./schema";

// Small pure changes to a config, for the setup screen. Each returns a new config; saving it
// (and validating) is the caller's job.

/** Turns a kind of source on (adding `source` if none of its type is there) or off (all of it). */
export function withSource(config: Config, source: SourceConfig, on: boolean): Config {
  const others = config.sources.filter((s) => s.type !== source.type);
  const existing = config.sources.filter((s) => s.type === source.type);
  return {
    ...config,
    sources: on ? [...others, ...(existing.length ? existing : [source])] : others,
  };
}

/**
 * Remembers something in the person's words; the same thing twice (however it's said) is kept
 * once, and the list has a limit the schema enforces.
 */
export function withMemory(config: Config, text: string): Config {
  const clean = text.trim();
  if (!clean || config.memories.some((m) => same(m, clean))) return config;
  return { ...config, memories: [...config.memories, clean] };
}

/**
 * Forgets a memory, by its own words or a part of them: "the ticket key one" removes "Put the
 * ticket key first". Returns the config and whether something was forgotten.
 */
export function withoutMemory(
  config: Config,
  text: string,
): { config: Config; forgotten: string | null } {
  const said = text.trim().toLowerCase();
  const exact = config.memories.find((m) => m.toLowerCase() === said);
  const partial = exact ?? config.memories.filter((m) => m.toLowerCase().includes(said));
  const one = exact ?? (partial.length === 1 ? partial[0] : undefined);
  if (!one) return { config, forgotten: null };
  return {
    config: { ...config, memories: config.memories.filter((m) => m !== one) },
    forgotten: one,
  };
}

function same(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Claude Code project folders to leave out. An empty list removes the key (TOML has no undefined). */
export function withClaudeExclude(config: Config, exclude: string[]): Config {
  return {
    ...config,
    sources: config.sources.map((s) => {
      if (s.type !== "claude-code") return s;
      const { exclude: _old, ...rest } = s;
      return exclude.length ? { ...rest, exclude } : rest;
    }),
  };
}

export function withDay(config: Config, day: Partial<Config["day"]>): Config {
  return { ...config, day: { ...config.day, ...day } };
}

/** Adds a project by name (one you log time to by hand), unless there's one by that name already. */
export function withProject(config: Config, name: string, task?: string): Config {
  const clean = name.trim();
  if (!clean || config.projects.some((p) => p.name.toLowerCase() === clean.toLowerCase()))
    return config;
  return { ...config, projects: [...config.projects, { name: clean, ...(task ? { task } : {}) }] };
}

/** Removes the project rule at `index` in `[[projects]]`. */
export function withoutProject(config: Config, index: number): Config {
  return { ...config, projects: config.projects.filter((_, i) => i !== index) };
}

export function withAi(config: Config, backend: Config["ai"]["backend"]): Config {
  return { ...config, ai: { ...config.ai, backend } };
}

/** Changes how descriptions are written; an empty `instructions` or `examples` removes them. */
export function withDescriptions(config: Config, change: Partial<Config["descriptions"]>): Config {
  const next = { ...config.descriptions, ...change };
  if (!next.instructions?.trim()) delete next.instructions;
  if (!next.examples?.length) delete next.examples;
  return { ...config, descriptions: next };
}

/** Changes how standups are written; an empty `instructions` or `examples` removes them. */
export function withStandup(config: Config, change: Partial<Config["standup"]>): Config {
  const next = { ...config.standup, ...change };
  if (!next.instructions?.trim()) delete next.instructions;
  if (!next.examples?.length) delete next.examples;
  return { ...config, standup: next };
}

/** 450 → "7h30m", the duration format config.toml uses. */
export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h ? `${h}h` : ""}${m ? `${m}m` : ""}` || "0m";
}

/** "09:30" ↔ minutes since midnight. */
export function clockMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

export function clockText(minutes: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Adds a remote MCP server, or points the one with its name at a new address. */
export function withMcpServer(config: Config, server: McpServer): Config {
  return { ...config, mcp: [...config.mcp.filter((s) => s.name !== server.name), server] };
}

/** Sends a project's rows (or only its `task` rows) to an ERP task; replaces an older choice. */
export function withTaskMapping(config: Config, mapping: TaskMapping): Config {
  const t = config.timesheet;
  if (!t) return config;
  const map = t.map.filter((m) => !(m.project === mapping.project && m.task === mapping.task));
  return { ...config, timesheet: { ...t, map: [...map, mapping] } };
}

/** Forgets which ERP task a project (and task) goes to; it's asked again on the next send. */
export function withoutTaskMapping(config: Config, mapping: Pick<TaskMapping, "project" | "task">) {
  const t = config.timesheet;
  if (!t) return config;
  const map = t.map.filter((m) => !(m.project === mapping.project && m.task === mapping.task));
  return { ...config, timesheet: { ...t, map } };
}

type ExportFormatInput = Omit<ExportFormat, "merge"> & { merge?: boolean };

/** Adds an export format, or replaces the one with its name; a new default takes over from the old. */
export function withExport(config: Config, format: ExportFormatInput): Config {
  const others = config.exports
    .filter((e) => e.name !== format.name)
    .map((e) => (format.default && e.default ? withoutDefault(e) : e));
  return { ...config, exports: [...others, { merge: true, ...format }] };
}

/** Removes the export format called `name`. */
export function withoutExport(config: Config, name: string): Config {
  return { ...config, exports: config.exports.filter((e) => e.name !== name) };
}

/** Makes `name` what Ctrl+Y copies as; none goes back to rows to paste. */
export function withCopyDefault(config: Config, name?: string): Config {
  return {
    ...config,
    exports: config.exports.map((e) =>
      e.name === name ? { ...e, default: true } : withoutDefault(e),
    ),
  };
}

function withoutDefault(e: ExportFormat): ExportFormat {
  const { default: _, ...rest } = e;
  return rest;
}
