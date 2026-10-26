import { type ErpCredentials, loadErpCredentials, saveErpCredentials } from "../config/credentials";
import type { Config } from "../config/schema";
import { commandTarget } from "./command";
import { httpTarget } from "./http";
import { nextPms } from "./next-pms";
import { erpAuth, type Fetch, siteOrigin } from "./next-pms/oauth";
import type { Target } from "./types";

export interface TargetDeps {
  fetch?: Fetch;
  env?: NodeJS.ProcessEnv;
  credentials?: () => Promise<ErpCredentials | null>;
  saveCredentials?: (c: ErpCredentials) => Promise<void>;
}

/**
 * The timesheet system from config, signed in. Null when none is set up; throws when one is
 * set up but not connected.
 */
export async function openTarget(config: Config, deps: TargetDeps = {}): Promise<Target | null> {
  const t = config.timesheet;
  if (!t) return null;
  if (t.type === "http") {
    const token = (deps.env ?? process.env)[t.token_env];
    if (!token)
      throw new Error(
        `Set ${t.token_env} to your timesheet API's token (from ${new URL(t.url).host}), then try again.`,
      );
    return httpTarget(t.url, token, t.token_env, deps.fetch);
  }
  if (t.type === "command") return commandTarget(t.run);
  const creds = await (deps.credentials ?? loadErpCredentials)();
  if (!creds || creds.url !== siteOrigin(t.url)) {
    throw new Error(
      `Not signed in to ${siteOrigin(t.url)}. Run \`clockout connect erp ${t.url}\`.`,
    );
  }
  const auth = erpAuth(creds, deps.saveCredentials ?? ((c) => saveErpCredentials(c)), deps.fetch);
  return nextPms(t.url, auth, deps.fetch);
}

export type { Target };
