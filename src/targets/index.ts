import { type ErpCredentials, loadErpCredentials, saveErpCredentials } from "../config/credentials";
import type { Config } from "../config/schema";
import { nextPms } from "./next-pms";
import { erpAuth, type Fetch, siteOrigin } from "./next-pms/oauth";
import type { Target } from "./types";

export interface TargetDeps {
  fetch?: Fetch;
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
