import type { Config } from "../config/schema";
import { HELPER_NAMES } from "../config/setting-ops";
import { claudeCliBackend } from "./claude-cli";
import { cliRunner, cliVersion, type Runner } from "./cli";
import { opencodeCliBackend } from "./opencode-cli";
import { piCliBackend } from "./pi-cli";
import type { LlmBackend } from "./types";

/** How long one call to a helper may take. */
const CALL_TIMEOUT_MS = 120_000;

export type BackendId = Exclude<Config["ai"]["backend"], "auto" | "none">;

export interface BackendInfo {
  id: BackendId;
  name: string;
  /** The CLI on PATH. */
  command: string;
  create(model?: string, run?: Runner): LlmBackend;
}

/** The agent CLIs that can be the AI helper, in the order "auto" tries them. */
export const BACKENDS: BackendInfo[] = [
  {
    id: "claude-code",
    name: HELPER_NAMES["claude-code"],
    command: "claude",
    create: (m, run) => claudeCliBackend(claudeModel(m) ?? "haiku", run),
  },
  {
    id: "opencode",
    name: HELPER_NAMES.opencode,
    command: "opencode",
    create: (m, run) => opencodeCliBackend(otherModel(m), run),
  },
  {
    id: "pi",
    name: HELPER_NAMES.pi,
    command: "pi",
    create: (m, run) => piCliBackend(otherModel(m), run),
  },
];

const CLAUDE_MODEL = /^(?:haiku|sonnet|opus)$|^claude-/i;

// One `ai.model` serves whichever helper runs: a Claude model only goes to Claude Code, any other
// only to the rest, so a model left over from one helper never breaks another.
function claudeModel(m?: string) {
  return m && CLAUDE_MODEL.test(m) ? m : undefined;
}
function otherModel(m?: string) {
  return m && !CLAUDE_MODEL.test(m) ? m : undefined;
}

/** Names of the helpers, for messages: "Claude Code, opencode or Pi". */
export const BACKEND_NAMES = `${BACKENDS.slice(0, -1)
  .map((b) => b.name)
  .join(", ")} or ${BACKENDS.at(-1)?.name}`;

export function backendInfo(id: string): BackendInfo | undefined {
  return BACKENDS.find((b) => b.id === id);
}

/** Which helpers are installed here, with their versions, in "auto" order. */
export async function detectBackends(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ id: BackendId; name: string; version: string }[]> {
  const found = await Promise.all(
    BACKENDS.map(async (b) => {
      const version = await cliVersion(b.command, env);
      return version ? [{ id: b.id, name: b.name, version }] : [];
    }),
  );
  return found.flat();
}

export interface AiChoice {
  /** Null when there's no AI helper: titles are used and typed corrections are off. */
  backend: LlmBackend | null;
  /** Why there's none although the config wants one, to show the person. */
  notice: string | null;
}

/**
 * The configured helper, or the first one installed for "auto". Never throws: without a helper
 * Clockout works on titles, and `notice` says so.
 */
export async function chooseBackend(
  config: Config,
  env: NodeJS.ProcessEnv = process.env,
): Promise<AiChoice> {
  const { backend, model } = config.ai;
  if (backend === "none") return { backend: null, notice: null };
  // Variables of ours that no helper gets: the timesheet token's own, beside the fixed ones.
  const withheld =
    config.timesheet && "token_env" in config.timesheet && config.timesheet.token_env
      ? [config.timesheet.token_env]
      : [];
  const wanted = backend === "auto" ? BACKENDS : BACKENDS.filter((b) => b.id === backend);
  for (const b of wanted) {
    if (await cliVersion(b.command, env))
      return { backend: b.create(model, cliRunner(CALL_TIMEOUT_MS, withheld)), notice: null };
  }
  const why =
    backend === "auto"
      ? `No AI helper found (${BACKEND_NAMES})`
      : `The AI helper is set to ${backendInfo(backend)?.name ?? backend}, but \`${backendInfo(backend)?.command ?? backend}\` isn't on your PATH`;
  return {
    backend: null,
    notice: `${why}. Descriptions come from session and PR titles, and typed corrections are off.`,
  };
}
