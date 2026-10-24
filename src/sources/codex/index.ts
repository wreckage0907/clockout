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
import { parseRemote, repoForDir } from "../git-remote";
import type { DateRange, Detected, Source, SourceContext } from "../types";

export interface CodexConfig {
  type: "codex";
  sessions_dir?: string | undefined;
}

// Only the fields Clockout uses. Each line is { timestamp, type, payload }: `session_meta` first
// (id, cwd, git), `turn_context` when a turn starts (cwd), `event_msg` for what happened
// (a prompt you typed is `user_message`, or from about 0.149 an `item_completed` whose item is a
// `UserMessage`) and `response_item` for what went to and from the model.
const line = z.object({
  timestamp: z.string(),
  type: z.string(),
  payload: z
    .object({
      type: z.string().optional(),
      role: z.string().optional(),
      id: z.string().optional(),
      cwd: z.string().optional(),
      source: z.unknown().optional(),
      thread_source: z.string().optional(),
      item: z.object({ type: z.string() }).optional(),
      git: z
        .object({ branch: z.string().optional(), repository_url: z.string().optional() })
        .optional(),
    })
    .optional(),
});

export const codex: Source<CodexConfig> = {
  id: "codex",
  name: "Codex",
  async detect(ctx) {
    const dir = sessionsDir(ctx);
    let sessions = 0;
    for await (const _ of rolloutFiles(dir)) sessions++;
    if (sessions === 0) return null;
    return {
      summary: `${sessions} session${sessions === 1 ? "" : "s"} in ${tildify(dir, ctx.homeDir)}`,
    } satisfies Detected;
  },
  async *collect(range, cfg, ctx) {
    const resolveRepo = ctx.resolveRepo ?? repoForDir;
    const dir = sessionsDir(ctx, cfg.sessions_dir);
    await requireFolder("Codex", dir);
    for await (const file of rolloutFiles(dir, range)) {
      if (!(await changedSince(file, range.from))) continue;
      yield* sessionActivities("codex", await readCodexSession(file), range, resolveRepo);
    }
  },
};

/** Codex keeps sessions in $CODEX_HOME/sessions, defaulting to ~/.codex/sessions. */
export function sessionsDir(ctx: Omit<SourceContext, "config">, override?: string): string {
  return override ?? join(ctx.env.CODEX_HOME || join(ctx.homeDir, ".codex"), "sessions");
}

const DAY = 86_400_000;

/**
 * `YYYY/MM/DD/rollout-*.jsonl` files. With a range, day folders after it are skipped (a day of
 * slack for time zones); a folder before it can still hold a session that ran on. Compressed
 * (`.jsonl.zst`) rollouts aren't read.
 */
async function* rolloutFiles(dir: string, range?: DateRange): AsyncGenerator<string> {
  const names = async (d: string) => (await readdir(d).catch(() => [] as string[])).sort();
  for (const y of await names(dir)) {
    for (const m of await names(join(dir, y))) {
      for (const d of await names(join(dir, y, m))) {
        const day = Date.parse(`${y}-${m}-${d}T00:00:00Z`);
        if (range && day > range.to.getTime() + DAY) continue;
        for (const name of await names(join(dir, y, m, d))) {
          if (name.startsWith("rollout-") && name.endsWith(".jsonl"))
            yield join(dir, y, m, d, name);
        }
      }
    }
  }
}

export async function readCodexSession(file: string): Promise<AgentSession> {
  const events: SessionEvent[] = [];
  let sessionId = "";
  let cwd: string | undefined;
  let branch: string | undefined;
  let repo: string | undefined;
  let skipped = 0;
  for await (const raw of jsonLines(file)) {
    const parsed = line.safeParse(raw);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const { type, payload } = parsed.data;
    if (type === "session_meta" && payload) {
      if (isSubagent(payload)) return { sessionId: payload.id ?? "", events: [], skipped };
      sessionId ||= payload.id ?? "";
      cwd = payload.cwd ?? cwd;
      branch = payload.git?.branch ?? branch;
      repo = payload.git?.repository_url ? parseRemote(payload.git.repository_url) : repo;
      continue;
    }
    if (type === "turn_context") {
      cwd = payload?.cwd ?? cwd;
      continue;
    }
    const kind = eventKind(type, payload);
    if (!kind) continue;
    const at = parseTime(parsed.data.timestamp);
    if (!at) {
      skipped++;
      continue;
    }
    events.push({ at, kind, cwd, branch });
  }
  return { sessionId, repo, events, skipped };
}

type Payload = NonNullable<z.infer<typeof line>["payload"]>;

/**
 * A prompt is the `user_message` event, or in newer versions the completed `UserMessage` item; a
 * file has one or the other. The `user` and `developer` messages sent to the model also hold
 * injected context (instructions, environment), so they don't count as either side.
 */
function eventKind(type: string, payload: Payload | undefined): SessionEvent["kind"] | null {
  if (type === "event_msg") {
    if (payload?.type === "user_message") return "prompt";
    if (payload?.type === "item_completed" && payload.item?.type === "UserMessage") return "prompt";
    return null;
  }
  if (type !== "response_item") return null;
  if (payload?.type === "message" && payload.role !== "assistant") return null;
  return "agent";
}

/** Reviews and helpers Codex starts on its own; their time is already in the parent session. */
function isSubagent(payload: Payload): boolean {
  if (payload.thread_source === "subagent") return true;
  const src = payload.source;
  return typeof src === "object" && src !== null && "subagent" in src;
}
