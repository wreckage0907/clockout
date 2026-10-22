import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { tildify } from "../../config/paths";
import {
  type AgentSession,
  changedSince,
  jsonLines,
  parseTime,
  type SessionEvent,
  sessionActivities,
} from "../agent-session";
import { repoForDir } from "../git-remote";
import { openReadOnly } from "../sqlite";
import type { Detected, Source, SourceContext } from "../types";

export interface AntigravityConfig {
  type: "antigravity";
  dir?: string | undefined;
}

// Antigravity's CLI (`agy`) keeps each conversation's steps in
// brain/<id>/.system_generated/logs/transcript.jsonl and an index of conversations (title,
// workspace folders, parent for subagents) in conversation_summaries.db. The IDE's own
// conversations are opaque protobuf files and aren't read.
const step = z.object({
  type: z.string(),
  source: z.string().optional(),
  created_at: z.string(),
});

const summaryRow = z.object({
  conversation_id: z.string(),
  title: z.string(),
  workspace_uris: z.string(),
  parent_conversation_id: z.string(),
});

interface Summary {
  title?: string | undefined;
  cwd?: string | undefined;
  subagent: boolean;
}

export const antigravity: Source<AntigravityConfig> = {
  id: "antigravity",
  name: "Antigravity",
  async detect(ctx) {
    const dir = agyDir(ctx);
    let n = 0;
    for (const id of await conversationIds(dir)) {
      if ((await stat(transcriptPath(dir, id)).catch(() => null))?.isFile()) n++;
    }
    if (n === 0) return null;
    return {
      summary: `${n} conversation${n === 1 ? "" : "s"} in ${tildify(dir, ctx.homeDir)}`,
    } satisfies Detected;
  },
  async *collect(range, cfg, ctx) {
    const resolveRepo = ctx.resolveRepo ?? repoForDir;
    const dir = agyDir(ctx, cfg.dir);
    let index: Map<string, Summary> | undefined;
    for (const id of await conversationIds(dir)) {
      const file = transcriptPath(dir, id);
      if (!(await changedSince(file, range.from))) continue;
      index ??= await readIndex(dir);
      const summary = index.get(id);
      if (summary?.subagent) continue;
      yield* sessionActivities(
        "antigravity",
        await readAntigravityTranscript(file, id, summary),
        range,
        resolveRepo,
      );
    }
  },
};

/** The CLI's data folder, ~/.gemini/antigravity-cli. */
export function agyDir(ctx: Omit<SourceContext, "config">, override?: string): string {
  return override ?? join(ctx.homeDir, ".gemini", "antigravity-cli");
}

function transcriptPath(dir: string, id: string): string {
  return join(dir, "brain", id, ".system_generated", "logs", "transcript.jsonl");
}

async function conversationIds(dir: string): Promise<string[]> {
  const entries = await readdir(join(dir, "brain"), { withFileTypes: true }).catch(() => []);
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

/** Titles, folders and subagents by conversation id; empty when the index can't be read. */
async function readIndex(dir: string): Promise<Map<string, Summary>> {
  const out = new Map<string, Summary>();
  const db = await openReadOnly(join(dir, "conversation_summaries.db"));
  if (!db) return out;
  try {
    const rows = db
      .prepare(
        "SELECT conversation_id, title, workspace_uris, parent_conversation_id FROM conversation_summaries",
      )
      .all();
    for (const raw of rows) {
      const row = summaryRow.safeParse(raw);
      if (!row.success) continue;
      out.set(row.data.conversation_id, {
        title: row.data.title || undefined,
        cwd: firstFolder(row.data.workspace_uris),
        subagent: row.data.parent_conversation_id !== "",
      });
    }
  } catch {
    // a layout this version doesn't know: transcripts still count, without titles
  } finally {
    db.close();
  }
  return out;
}

/** The first `file://` workspace in a JSON array of URIs. */
function firstFolder(json: string): string | undefined {
  let uris: unknown;
  try {
    uris = JSON.parse(json);
  } catch {
    return undefined;
  }
  const first = z
    .array(z.string())
    .safeParse(uris)
    .data?.find((u) => u.startsWith("file://"));
  return first ? fileURLToPath(first) : undefined;
}

export async function readAntigravityTranscript(
  file: string,
  id: string,
  summary?: Summary,
): Promise<AgentSession> {
  const events: SessionEvent[] = [];
  let skipped = 0;
  for await (const raw of jsonLines(file)) {
    const parsed = step.safeParse(raw);
    const at = parseTime(parsed.data?.created_at);
    if (!parsed.success || !at) {
      skipped++;
      continue;
    }
    const kind = stepKind(parsed.data);
    if (kind) events.push({ at, kind, cwd: summary?.cwd });
  }
  return { sessionId: id, title: summary?.title, events, skipped };
}

/** You typed a prompt; the model planned or acted. System messages and errors carry no timing. */
function stepKind(s: z.infer<typeof step>): SessionEvent["kind"] | null {
  if (s.type === "USER_INPUT") return s.source?.startsWith("USER") ? "prompt" : null;
  return s.source === "MODEL" ? "agent" : null;
}
