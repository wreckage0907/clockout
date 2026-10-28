import type { Config } from "../config/schema";
import { DEFAULT_TOKEN_ENV } from "../config/schema";
import type { Fetch } from "../oauth";
import { commandTarget } from "./command";
import { httpTarget } from "./http";
import type { Target } from "./types";

export interface TargetDeps {
  fetch?: Fetch;
  env?: NodeJS.ProcessEnv;
}

/**
 * The timesheet system from config. Null when none is set up; throws when one is set up but has
 * no token. The token comes from `token` in config.toml or from the environment variable named
 * by `token_env`; wherever it came from, it never appears in an error message.
 */
export async function openTarget(config: Config, deps: TargetDeps = {}): Promise<Target | null> {
  const t = config.timesheet;
  if (!t) return null;
  if (t.type === "command") return commandTarget(t.run);
  const envName = t.token_env ?? DEFAULT_TOKEN_ENV;
  const token = t.token ?? (deps.env ?? process.env)[envName];
  if (!token)
    throw new Error(
      `Set ${envName} to your timesheet API's token (from ${new URL(t.url).host})${
        t.token_env ? "" : ' or put token = "…" under [timesheet] in config.toml'
      }, then try again.`,
    );
  return withoutToken(
    httpTarget(t.url, token, t.token ? "config.toml" : envName, deps.fetch),
    token,
  );
}

/** The target, with the token blanked out of any error it throws (a server might echo it back). */
function withoutToken(target: Target, token: string): Target {
  const clean = (err: unknown): never => {
    if (!(err instanceof Error) || !err.message.includes(token)) throw err;
    throw new Error(err.message.split(token).join("[token]"));
  };
  const guard =
    <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> =>
      fn(...args).catch(clean);
  return {
    id: target.id,
    name: target.name,
    day: guard(target.day),
    searchTasks: guard(target.searchTasks),
    create: guard(target.create),
    update: guard(target.update),
    remove: guard(target.remove),
  };
}

export type { Target };
