import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { tildify } from "../../config/paths";
import {
  type AgentSession,
  changedSince,
  jsonLines,
  parseTime,
  requireFolder,
  type SessionEvent,
  sessionActivities,
} from "../agent-session";
import { repoForDir } from "../git-remote";
import type { Detected, Source, SourceContext } from "../types";

export interface PiConfig {
  type: "pi";
  sessions_dir?: string | undefined;
}

// Only the fields Clockout uses. A session file starts with a `session` header (id, cwd), then
// `message` entries whose role is user, assistant, toolResult, bashExecution, …, plus metadata
// such as `session_info` (a name you gave the session).
const line = z.object({
  type: z.string(),
  id: z.string().optional(),
  timestamp: z.string().optional(),
  cwd: z.string().optional(),
  name: z.string().optional(),
  message: z.object({ role: z.string(), content: z.unknown().optional() }).optional(),
});

export const pi: Source<PiConfig> = {
  id: "pi",
  name: "Pi",
  async detect(ctx) {
    const dir = sessionsDir(ctx);
    const folders = await readdir(dir, { withFileTypes: true }).catch(() => []);
    let projects = 0;
    for (const f of folders) {
      if (!f.isDirectory()) continue;
      const files = await readdir(join(dir, f.name)).catch(() => [] as string[]);
      if (files.some((n) => n.endsWith(".jsonl"))) projects++;
    }
    if (projects === 0) return null;
    return {
      summary: `${projects} project${projects === 1 ? "" : "s"} in ${tildify(dir, ctx.homeDir)}`,
    } satisfies Detected;
  },
  async *collect(range, cfg, ctx) {
    const resolveRepo = ctx.resolveRepo ?? repoForDir;
    const dir = sessionsDir(ctx, cfg.sessions_dir);
    await requireFolder("Pi", dir);
    const folders = await readdir(dir).catch(() => [] as string[]);
    for (const folder of folders) {
      const files = await readdir(join(dir, folder)).catch(() => [] as string[]);
      for (const name of files) {
        const file = join(dir, folder, name);
        if (!name.endsWith(".jsonl") || !(await changedSince(file, range.from))) continue;
        yield* sessionActivities("pi", await readPiSession(file), range, resolveRepo);
      }
    }
  },
};

/** Pi keeps sessions in $PI_CODING_AGENT_DIR/sessions, defaulting to ~/.pi/agent/sessions. */
export function sessionsDir(ctx: Omit<SourceContext, "config">, override?: string): string {
  if (override) return override;
  const agentDir = ctx.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|\/)/, ctx.homeDir);
  return join(agentDir || join(ctx.homeDir, ".pi", "agent"), "sessions");
}

export async function readPiSession(file: string): Promise<AgentSession> {
  const events: SessionEvent[] = [];
  let sessionId = "";
  let cwd: string | undefined;
  let title: string | undefined;
  let skipped = 0;
  for await (const raw of jsonLines(file)) {
    const parsed = line.safeParse(raw);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const entry = parsed.data;
    if (entry.type === "session") {
      sessionId ||= entry.id ?? "";
      cwd ??= entry.cwd;
      continue;
    }
    if (entry.type === "session_info") {
      title = entry.name || undefined; // renamed during the session: the last name wins
      continue;
    }
    if (entry.type !== "message" || !entry.message) continue;
    const kind = eventKind(entry.message.role, entry.message.content);
    if (!kind) continue;
    const at = parseTime(entry.timestamp);
    if (!at) {
      skipped++;
      continue;
    }
    events.push({ at, kind, cwd });
  }
  return { sessionId, title, events, skipped };
}

/** You typed a prompt or ran a `!` command; the agent replied. Tool results carry no new timing. */
function eventKind(role: string, content: unknown): SessionEvent["kind"] | null {
  if (role === "user") return hasText(content) ? "prompt" : null;
  if (role === "bashExecution") return "prompt";
  if (role === "assistant") return "agent";
  return null;
}

function hasText(content: unknown): boolean {
  if (typeof content === "string") return content.trim() !== "";
  if (!Array.isArray(content)) return false;
  return content.some(
    (part) =>
      typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text",
  );
}
