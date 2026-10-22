import { join } from "node:path";
import { z } from "zod";
import { tildify } from "../../config/paths";
import { type AgentSession, type SessionEvent, sessionActivities } from "../agent-session";
import { repoForDir } from "../git-remote";
import { openReadOnly } from "../sqlite";
import type { DateRange, Detected, Source, SourceContext } from "../types";

export interface OpencodeConfig {
  type: "opencode";
  db?: string | undefined;
}

// opencode 2 keeps everything in one SQLite database. `session_v2` has a row per session
// (directory, title, parent_id for subagents; times in epoch ms) and `session_message` its
// messages in `seq` order, each a `type` (user, assistant, synthetic, idle, …) with JSON `data`.
// Only times and types are read here, never what was said.
const sessionRow = z.object({
  id: z.string(),
  directory: z.string(),
  title: z.string().nullable(),
});

const messageRow = z.object({
  /** `data` is JSON; a row whose isn't is counted as skipped. */
  valid: z.literal(1),
  type: z.string(),
  time_created: z.number(),
  /** An assistant reply's `time.completed`. */
  completed: z.number().nullable(),
  has_text: z.number().nullable(),
});

export const opencode: Source<OpencodeConfig> = {
  id: "opencode",
  name: "opencode",
  async detect(ctx) {
    const file = dbPath(ctx);
    const db = await openReadOnly(file);
    if (!db) return null;
    try {
      const row = db.prepare("SELECT count(*) AS n FROM session_v2 WHERE parent_id IS NULL").get();
      const n = Number(row?.n ?? 0);
      if (n === 0) return null;
      return {
        summary: `${n} session${n === 1 ? "" : "s"} in ${tildify(file, ctx.homeDir)}`,
      } satisfies Detected;
    } catch {
      return null; // an older layout without session_v2
    } finally {
      db.close();
    }
  },
  async *collect(range, cfg, ctx) {
    const resolveRepo = ctx.resolveRepo ?? repoForDir;
    for (const session of await readOpencodeSessions(dbPath(ctx, cfg.db), range)) {
      yield* sessionActivities("opencode", session, range, resolveRepo);
    }
  },
};

/** $XDG_DATA_HOME/opencode/opencode.db, defaulting to ~/.local/share/opencode/opencode.db. */
export function dbPath(ctx: Omit<SourceContext, "config">, override?: string): string {
  if (override) return override;
  const data = ctx.env.XDG_DATA_HOME || join(ctx.homeDir, ".local", "share");
  return join(data, "opencode", "opencode.db");
}

/** Top-level sessions active in the range; subagent sessions are left out like other agents'. */
export async function readOpencodeSessions(
  file: string,
  range: DateRange,
): Promise<AgentSession[]> {
  const db = await openReadOnly(file);
  if (!db) return [];
  try {
    const sessions = db
      .prepare(
        `SELECT id, directory, title FROM session_v2
         WHERE parent_id IS NULL AND time_updated >= ? AND time_created < ?
         ORDER BY time_created`,
      )
      .all(range.from.getTime(), range.to.getTime());
    const messages = db.prepare(
      `SELECT json_valid(data) AS valid, type, time_created,
         CASE WHEN json_valid(data) THEN json_extract(data, '$.time.completed') END AS completed,
         CASE WHEN json_valid(data) THEN length(trim(json_extract(data, '$.text'))) > 0 END AS has_text
       FROM session_message WHERE session_id = ? ORDER BY seq`,
    );
    const out: AgentSession[] = [];
    for (const raw of sessions) {
      const s = sessionRow.safeParse(raw);
      if (!s.success) continue;
      const events: SessionEvent[] = [];
      let skipped = 0;
      for (const m of messages.all(s.data.id)) {
        const msg = messageRow.safeParse(m);
        if (!msg.success) {
          skipped++;
          continue;
        }
        events.push(...messageEvents(msg.data, s.data.directory));
      }
      out.push({ sessionId: s.data.id, title: realTitle(s.data.title), events, skipped });
    }
    return out;
  } catch {
    return []; // an older layout without session_v2 / session_message
  } finally {
    db.close();
  }
}

/** Until opencode names a session its title is a placeholder like "New session - <time>". */
function realTitle(title: string | null): string | undefined {
  return title && !/^(New|Child) session - /.test(title) ? title : undefined;
}

/** A prompt you typed; an assistant reply spans from when it started to when it completed. */
function messageEvents(m: z.infer<typeof messageRow>, cwd: string): SessionEvent[] {
  if (m.type === "user")
    return m.has_text ? [{ at: new Date(m.time_created), kind: "prompt", cwd }] : [];
  if (m.type !== "assistant") return [];
  const start: SessionEvent = { at: new Date(m.time_created), kind: "agent", cwd };
  return m.completed ? [start, { at: new Date(m.completed), kind: "agent", cwd }] : [start];
}
