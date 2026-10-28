import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { tildify } from "./paths";
import { type Config, type ConfigInput, configSchema } from "./schema";

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`Problem in ${tildify(file)}:\n${detail}`);
    this.name = "ConfigError";
  }
}

/** Returns null when the file doesn't exist; throws ConfigError when it's invalid. */
export async function loadConfig(file: string): Promise<Config | null> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  return parseConfig(text, file);
}

export function parseConfig(text: string, file = "config.toml"): Config {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    // A syntax error quotes the line it's on, and that line may be `token = …`.
    throw new ConfigError(file, (err as Error).message.replace(/(\btoken\s*=\s*).*/g, "$1…"));
  }
  if (raw && typeof raw === "object" && Object.keys(raw).length === 0)
    throw new ConfigError(file, "It's empty. Run `clockout init --force` to write one.");
  dropRemovedHelper(raw);
  if (removedTarget(raw)) throw new ConfigError(file, NEXT_PMS_REMOVED);
  const result = configSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(file, z.prettifyError(result.error));
  return result.data;
}

let warnedRemovedHelper = false;

/**
 * The Codex AI helper was removed (docs/plan.md, "Later"). A config that still names it keeps
 * working on "auto", with one line saying so; the next save writes the new value.
 */
function dropRemovedHelper(raw: unknown): void {
  const ai = raw && typeof raw === "object" ? (raw as { ai?: unknown }).ai : undefined;
  if (!ai || typeof ai !== "object" || (ai as { backend?: unknown }).backend !== "codex") return;
  (ai as { backend: string }).backend = "auto";
  if (warnedRemovedHelper) return;
  warnedRemovedHelper = true;
  console.error(
    'warning: the Codex AI helper was removed; using ai.backend = "auto" instead. Set it to claude-code, opencode, pi or none in config.toml to silence this.',
  );
}

/**
 * Writes the config readable only by the user: it can hold a private calendar URL.
 * Validates first so a bad config is never saved.
 */
export async function saveConfig(file: string, config: ConfigInput): Promise<void> {
  const result = configSchema.safeParse(config);
  if (!result.success) throw new ConfigError(file, z.prettifyError(result.error));
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${HEADER}${stringify(config)}\n`, { mode: 0o600 });
  // `mode` only counts for a new file, and this one can hold a timesheet token.
  await chmod(file, 0o600);
}

/** `[timesheet] type = "next-pms"`, from before ADR 0013 took that target out. */
function removedTarget(raw: unknown): boolean {
  const t = raw && typeof raw === "object" ? (raw as { timesheet?: unknown }).timesheet : undefined;
  return !!t && typeof t === "object" && (t as { type?: unknown }).type === "next-pms";
}

const NEXT_PMS_REMOVED = `[timesheet] type = "next-pms" isn't supported any more: Clockout no longer has a target
tied to one ERP. To keep sending your days to your timesheet system, change [timesheet] to one
of these (your [[timesheet.map]] entries stay as they are):
  type = "http"     a server that speaks Clockout's small JSON API (see docs/timesheet-api.md):
                    url = "https://…", and its token in the environment variable named by
                    token_env, or as token = "…"
  type = "command"  a program you name: run = ["your-program", "--timesheet"]
Still on next-pms? docs/next-pms-setup.md walks through the command target for it:
https://github.com/wreckage0907/clockout/blob/main/docs/next-pms-setup.md
Or delete the [timesheet] section to stop sending. The ERP sign-in in credentials.json is no
longer used.`;

const HEADER = `# Clockout config. Docs: https://github.com/wreckage0907/clockout/blob/main/docs/spec.md
# This file can contain your private calendar URL; keep it to yourself.

`;
