import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  type AgentSession,
  changedSince,
  jsonLines,
  parseTime,
  type SessionEvent,
  sessionActivities,
} from "../agent-session";
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

export const claudeCode: Source<ClaudeCodeConfig> = {
  id: "claude-code",
  name: "Claude Code",
  detect: detectClaudeCode,
  async *collect(range, cfg, ctx) {
    const resolveRepo = ctx.resolveRepo ?? repoForDir;
    const skip = new Set(cfg.exclude ?? []);
    for await (const file of sessionFiles(projectsDir(ctx, cfg.projects_dir), range, skip)) {
      const session = await readSession(file);
      yield* sessionActivities("claude-code", session, range, resolveRepo);
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
      if (await changedSince(file, range.from)) yield file;
    }
  }
}

export async function readSession(file: string): Promise<AgentSession> {
  const events: SessionEvent[] = [];
  let title: string | undefined;
  let sessionId = "";
  let skipped = 0;
  for await (const raw of jsonLines(file)) {
    const result = line.safeParse(raw);
    if (!result.success) {
      skipped++;
      continue;
    }
    const parsed: Line = result.data;
    sessionId ||= parsed.sessionId ?? "";
    if (parsed.type === "ai-title" && parsed.aiTitle) {
      title = parsed.aiTitle; // titles are refined during a session; the last one wins
      continue;
    }
    if (parsed.isSidechain || parsed.isMeta || !parsed.timestamp) continue;
    const at = parseTime(parsed.timestamp);
    if (!at) {
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
