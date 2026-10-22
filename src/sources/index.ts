import { calendar } from "./calendar";
import { claudeCode } from "./claude-code";
import { codex } from "./codex";
import { github } from "./github";
import { googleCalendar } from "./google-calendar";
import { pi } from "./pi";
import type { Source } from "./types";

// Each source registers here once its collector exists.
export const sources: readonly Source[] = [
  claudeCode as Source,
  pi as Source,
  codex as Source,
  github as Source,
  calendar as Source,
  googleCalendar as Source,
];

export function getSource(id: string): Source | undefined {
  return sources.find((s) => s.id === id);
}
