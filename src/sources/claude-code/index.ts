import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { Activity } from "../../core/types";
import { repoForDir } from "../git-remote";
import type { DateRange, Source } from "../types";
import { detectClaudeCode, projectsDir } from "./paths";

export interface ClaudeCodeConfig {
  type: "claude-code";
  projects_dir?: string | undefined;
  exclude?: string[] | undefined;
}

// Only the fields Clockout uses; everything else in a line is ignored.
const line = z.object({
  type: z.string(),
  timestamp: z.string().optional(),
  sessionId: z.string().optional(),
  cwd: z.string().optional(),
  gitBranch: z.string().optional(),
  isSidechain: z.boolean().optional(),
  isMeta: z.boolean().optional(),
  aiTitle: z.string().optional(),
  message: z.object({ content: z.unknown() }).optional(),
});
type Line = z.infer<typeof line>;

interface Event {
  at: Date;
  kind: "prompt" | "agent";
  cwd?: string | undefined;
  branch?: string | undefined;
}

export interface SessionSummary {
  sessionId: string;
  title?: string | undefined;
  events: Event[];
  skipped: number;
}

export const claudeCode: Source<ClaudeCodeConfig> = {
  id: "claude-code",
  name: "Claude Code",
  detect: detectClaudeCode,
  async *collect(range, cfg, ctx) {
    const resolveRepo = ctx.resolveRepo ?? repoForDir;
    const skip = new Set(cfg.exclude ?? []);
    for await (const file of sessionFiles(projectsDir(ctx, cfg.projects_dir), range, skip)) {
      const session = await readSession(file);
      yield* toActivities(session, range, resolveRepo);
    }
  },
};

/** Session files that could contain events in `range` (modified on or after its start). */
async function* sessionFiles(
  dir: string,
  range: DateRange,
  skip: Set<string>,
): AsyncGenerator<string> {
  let projects: string[];
  try {
    projects = await readdir(dir);
  } catch {
    return;
  }
  for (const project of projects) {
    if (skip.has(project)) continue;
    let files: string[];
    try {
      files = await readdir(join(dir, project));
    } catch {
      continue;
    }
    for (const name of files) {
      if (!name.endsWith(".jsonl")) continue;
      const file = join(dir, project, name);
      const info = await stat(file).catch(() => null);
      if (info?.isFile() && info.mtime >= range.from) yield file;
    }
  }
}

export async function readSession(file: string): Promise<SessionSummary> {
  const events: Event[] = [];
  let title: string | undefined;
  let sessionId = "";
  let skipped = 0;
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const raw of lines) {
    if (!raw.trim()) continue;
    let parsed: Line;
    try {
      parsed = line.parse(JSON.parse(raw));
    } catch {
      skipped++;
      continue;
    }
    sessionId ||= parsed.sessionId ?? "";
    if (parsed.type === "ai-title" && parsed.aiTitle) {
      title = parsed.aiTitle; // titles are refined during a session; the last one wins
      continue;
    }
    if (parsed.isSidechain || parsed.isMeta || !parsed.timestamp) continue;
    const at = new Date(parsed.timestamp);
    if (Number.isNaN(at.getTime())) {
      skipped++;
      continue;
    }
    const kind =
      parsed.type === "user" && isHumanPrompt(parsed.message?.content)
        ? "prompt"
        : parsed.type === "assistant"
          ? "agent"
          : null;
    if (kind) events.push({ at, kind, cwd: parsed.cwd, branch: parsed.gitBranch });
  }
  return { sessionId, title, events, skipped };
}

/** A typed prompt, as opposed to a tool result or local command output that Claude Code logs as `user`. */
export function isHumanPrompt(content: unknown): boolean {
  if (typeof content === "string") return !content.startsWith("<local-command-");
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
  );
}

/** Prompts become human activity; each run of assistant lines after a prompt becomes one agent turn. */
async function* toActivities(
  session: SessionSummary,
  range: DateRange,
  resolveRepo: (cwd: string) => Promise<string | undefined>,
): AsyncGenerator<Activity> {
  const inRange = (d: Date) => d >= range.from && d < range.to;
  const base = (e: Event) => ({
    source: "claude-code",
    title: session.title,
    cwd: e.cwd,
    branch: e.branch,
    sessionId: session.sessionId,
    refs: [`session:${session.sessionId}`],
  });
  const withRepo = async (a: Activity): Promise<Activity> => {
    const repo = a.cwd ? await resolveRepo(a.cwd) : undefined;
    return stripUndefined(repo ? { ...a, repo } : a);
  };

  let turn: { first: Event; last: Event } | null = null;
  const flush = async (): Promise<Activity | null> => {
    if (!turn || !inRange(turn.first.at)) return null;
    return withRepo({
      ...base(turn.first),
      kind: "agent_turn",
      actor: "agent",
      start: turn.first.at,
      end: turn.last.at,
    });
  };

  for (const e of session.events) {
    if (e.kind === "agent") {
      turn = turn ? { first: turn.first, last: e } : { first: e, last: e };
      continue;
    }
    const done = await flush();
    if (done) yield done;
    turn = null;
    if (inRange(e.at))
      yield await withRepo({ ...base(e), kind: "prompt", actor: "human", start: e.at });
  }
  const done = await flush();
  if (done) yield done;
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
