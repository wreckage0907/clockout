import { claudeCode } from "./claude-code";
import type { Source } from "./types";

// Each source registers here once its collector exists.
export const sources: readonly Source[] = [claudeCode as Source];

export function getSource(id: string): Source | undefined {
  return sources.find((s) => s.id === id);
}
