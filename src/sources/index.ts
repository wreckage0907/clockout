import type { Source } from "./types";

// Each source registers here once its collector exists (claude-code: day 2, github: day 3,
// calendar: day 4). Detection helpers live in each source's folder in the meantime.
export const sources: readonly Source[] = [];

export function getSource(id: string): Source | undefined {
  return sources.find((s) => s.id === id);
}
