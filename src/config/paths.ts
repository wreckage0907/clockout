import { homedir } from "node:os";
import { join } from "node:path";

export interface Paths {
  configFile: string;
  dataDir: string;
}

/**
 * XDG locations on every platform: $XDG_CONFIG_HOME/clockout/config.toml and
 * $XDG_DATA_HOME/clockout. CLOCKOUT_CONFIG overrides the config file (tests, --demo).
 */
export function resolvePaths(env: NodeJS.ProcessEnv = process.env, home = homedir()): Paths {
  const configHome = env.XDG_CONFIG_HOME || join(home, ".config");
  const dataHome = env.XDG_DATA_HOME || join(home, ".local", "share");
  return {
    configFile: env.CLOCKOUT_CONFIG || join(configHome, "clockout", "config.toml"),
    dataDir: join(dataHome, "clockout"),
  };
}

/** Replace the home directory prefix with "~" for display. */
export function tildify(path: string, home = homedir()): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
