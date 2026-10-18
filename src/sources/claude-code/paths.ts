import { readdir } from "node:fs/promises";
import { join } from "node:path";
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
