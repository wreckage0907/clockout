import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { tildify } from "../../config/paths";
import type { Detected, SourceContext } from "../types";

/** Claude Code keeps sessions in $CLAUDE_CONFIG_DIR/projects, defaulting to ~/.claude/projects. */
export function projectsDir(ctx: Omit<SourceContext, "config">, override?: string): string {
  return override ?? join(ctx.env.CLAUDE_CONFIG_DIR || join(ctx.homeDir, ".claude"), "projects");
}

export async function detectClaudeCode(
  ctx: Omit<SourceContext, "config">,
): Promise<Detected | null> {
  const dir = projectsDir(ctx);
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const projects = entries.filter((e) => e.isDirectory()).length;
    if (projects === 0) return null;
    return {
      summary: `${projects} project${projects === 1 ? "" : "s"} in ${tildify(dir, ctx.homeDir)}`,
    };
  } catch {
    return null;
  }
}

export interface ClaudeProject {
  /** Folder name inside the projects dir; what `exclude` lists. */
  folder: string;
  /** The working directory its sessions ran in, e.g. "~/code/clockout"; the folder when unknown. */
  path: string;
  /** Short name for lists: the directory's last part. */
  name: string;
  sessions: number;
  /** Sessions with activity since `since`. */
  recent: number;
}

/** Every Claude Code project folder, with session counts, for picking which to read. */
export async function listClaudeProjects(
  ctx: Omit<SourceContext, "config">,
  since: Date,
  override?: string,
): Promise<ClaudeProject[]> {
  const dir = projectsDir(ctx, override);
  const folders = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const out: ClaudeProject[] = [];
  for (const f of folders) {
    if (!f.isDirectory()) continue;
    const files = (await readdir(join(dir, f.name)).catch(() => [] as string[])).filter((n) =>
      n.endsWith(".jsonl"),
    );
    if (files.length === 0) continue;
    let recent = 0;
    let newest = { file: "", at: 0 };
    for (const name of files) {
      const info = await stat(join(dir, f.name, name)).catch(() => null);
      if (!info) continue;
      if (info.mtime >= since) recent++;
      if (info.mtimeMs > newest.at) newest = { file: name, at: info.mtimeMs };
    }
    const cwd = newest.file ? await firstCwd(join(dir, f.name, newest.file)) : undefined;
    out.push({
      folder: f.name,
      path: cwd ? tildify(cwd, ctx.homeDir) : f.name,
      name: cwd ? basename(cwd) : f.name,
      sessions: files.length,
      recent,
    });
  }
  return out.sort((a, b) => b.recent - a.recent || b.sessions - a.sessions);
}

/** The `cwd` from the first lines of a session file that have one. */
async function firstCwd(file: string): Promise<string | undefined> {
  const lines = createInterface({
    input: createReadStream(file),
    crlfDelay: Number.POSITIVE_INFINITY,
  });
  let n = 0;
  try {
    for await (const line of lines) {
      if (++n > 50) break;
      const m = /"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(line);
      if (m?.[1]) return JSON.parse(`"${m[1]}"`) as string;
    }
  } finally {
    lines.close();
  }
  return undefined;
}
