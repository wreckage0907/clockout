import type { Config } from "../config/schema";
import { claudeCliBackend, detectClaudeCli } from "./claude-cli";
import type { LlmBackend } from "./types";

/** The configured backend, or null for "none" (and for "auto" when nothing is installed). */
export async function chooseBackend(config: Config): Promise<LlmBackend | null> {
  const { backend, model } = config.ai;
  if (backend === "none") return null;
  const claude = await detectClaudeCli();
  if (claude) return claudeCliBackend(model);
  if (backend === "claude-code") {
    throw new Error("The config asks for Claude Code, but `claude` isn't on your PATH.");
  }
  return null;
}
