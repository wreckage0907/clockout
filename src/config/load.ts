import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { z } from "zod";
import { type Config, type ConfigInput, configSchema } from "./schema";

export class ConfigError extends Error {
  constructor(
    readonly file: string,
    detail: string,
  ) {
    super(`Problem in ${file}:\n${detail}`);
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
    throw new ConfigError(file, (err as Error).message);
  }
  if (raw && typeof raw === "object" && Object.keys(raw).length === 0)
    throw new ConfigError(file, "It's empty. Run `clockout init --force` to write one.");
  const result = configSchema.safeParse(raw);
  if (!result.success) throw new ConfigError(file, z.prettifyError(result.error));
  return result.data;
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
}

const HEADER = `# Clockout config. Docs: https://github.com/wreckage0907/clockout/blob/main/docs/spec.md
# This file can contain your private calendar URL; keep it to yourself.

`;
