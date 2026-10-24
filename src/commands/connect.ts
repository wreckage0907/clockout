import { homedir } from "node:os";
import { execa } from "execa";
import {
  credentialsPath,
  loadErpCredentials,
  loadGoogleCredentials,
  removeErpCredentials,
  removeGoogleCredentials,
  saveErpCredentials,
  saveGoogleCredentials,
} from "../config/credentials";
import { withErpSite } from "../config/edit";
import { loadConfig, saveConfig } from "../config/load";
import { resolvePaths, tildify } from "../config/paths";
import { type Config, isSafeSite } from "../config/schema";
import { dayRange, localDate } from "../core/time";
import { googleCalendar } from "../sources/google-calendar";
import { connectGoogle, googleClient, revoke } from "../sources/google-calendar/oauth";
import { connectErp, revokeErp, siteOrigin } from "../targets/next-pms/oauth";

/** Opens a URL in the default browser; the URL is printed too, in case that fails. */
const openInBrowser = (what: string) => async (url: string) => {
  console.log(
    `\nOpening ${what} sign-in in your browser. If it doesn't open, visit:\n\n  ${url}\n`,
  );
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  await execa(cmd, args as string[]).catch(() => undefined);
};

function check(service: string): "google" | "erp" {
  if (service !== "google" && service !== "erp")
    throw new Error(`Connect "google" (your calendar) or "erp" (where your timesheet goes).`);
  return service;
}

/**
 * `clockout connect google`: sign in once; Clockout reads your calendar from then on.
 * `clockout connect erp <url>`: sign in to your ERP so `clockout push` can fill your timesheet.
 */
export async function runConnect(service: string, url?: string) {
  if (check(service) === "erp") return connectErpSite(url);
  const { configFile } = resolvePaths();
  const config = await loadConfig(configFile);
  const client = googleClient(config);

  console.log("Clockout asks for read-only access to your calendar events, nothing else.");
  const { refreshToken, scope } = await connectGoogle(client, openInBrowser("Google"));
  await saveGoogleCredentials({
    refresh_token: refreshToken,
    client_id: client.client_id,
    scope,
    connected_at: new Date().toISOString(),
  });
  console.log(
    `Connected. The sign-in is kept in ${tildify(credentialsPath(), homedir())} (only you can read it).`,
  );

  if (config) {
    await addGoogleSource(config, configFile);
    await showToday(config);
  } else {
    console.log("Run `clockout init` to finish setting up.");
  }
}

export async function addGoogleSource(config: Config, configFile: string) {
  if (config.sources.some((s) => s.type === "google-calendar")) return;
  await saveConfig(configFile, {
    ...config,
    sources: [...config.sources, { type: "google-calendar", calendars: ["primary"] }],
  });
  if (config.sources.some((s) => s.type === "calendar")) {
    console.log(
      "You also have an ICS calendar set up; meetings that appear in both are counted once.",
    );
  }
}

async function showToday(config: Config) {
  const date = localDate(new Date(), config.me.timezone);
  let count = 0;
  for await (const _ of googleCalendar.collect(
    dayRange(date, config.me.timezone),
    { type: "google-calendar", calendars: ["primary"] },
    { config, homeDir: homedir(), env: process.env },
  )) {
    count++;
  }
  console.log(
    `Found ${count} event${count === 1 ? "" : "s"} today. Run \`clockout\` to review your day.`,
  );
}

async function connectErpSite(url: string | undefined) {
  const { configFile } = resolvePaths();
  const config = await loadConfig(configFile);
  const site = url ?? config?.timesheet?.url;
  if (!site)
    throw new Error("Give your ERP's address: clockout connect erp https://erp.example.com");
  const origin = erpOrigin(site);
  console.log(
    `Clockout signs in to ${origin} as you. It only reads and writes your own timesheet entries, and only when you send a day.`,
  );
  const connected = await signInErp(origin, openInBrowser("ERP"));
  console.log(
    `Connected${connected.user ? ` as ${connected.user}` : ""}. The sign-in is kept in ${tildify(credentialsPath(), homedir())} (only you can read it).`,
  );
  if (!config) {
    console.log("Run `clockout init` to finish setting up.");
    return;
  }
  await saveConfig(configFile, withErpSite(config, connected.url));
  console.log("Review a day with `clockout`, then send it with ctrl+s (or `clockout push`).");
}

/** "erp.example.com" or a full address → "https://erp.example.com". */
export function erpOrigin(site: string): string {
  const trimmed = site.trim().replace(/[.,!]+$/, "");
  let origin: string;
  try {
    origin = siteOrigin(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new Error(`"${site}" isn't a web address. Use e.g. https://erp.example.com`);
  }
  // Before signing in: the sign-in and your timesheet would cross the network unencrypted.
  if (!isSafeSite(origin)) throw new Error(`Use your ERP's https:// address (got ${origin}).`);
  return origin;
}

/** Signs in to the ERP in the browser and keeps the sign-in. */
export async function signInErp(site: string, open: (url: string) => Promise<void>) {
  const connected = await connectErp(erpOrigin(site), open);
  await saveErpCredentials({
    url: connected.url,
    client_id: connected.clientId,
    refresh_token: connected.refreshToken,
    ...(connected.user ? { user: connected.user } : {}),
    connected_at: new Date().toISOString(),
  });
  return connected;
}

/** Revokes the ERP sign-in and forgets it; the site and task mappings stay in the config. */
export async function signOutErp(): Promise<string | null> {
  const creds = await loadErpCredentials();
  if (creds) await revokeErp(creds);
  await removeErpCredentials();
  return creds?.url ?? null;
}

/** Revokes the Google sign-in and forgets it; true if there was one. */
export async function signOutGoogle(): Promise<boolean> {
  const creds = await loadGoogleCredentials();
  if (creds) await revoke(creds.refresh_token);
  await removeGoogleCredentials();
  return creds !== null;
}

/** `clockout disconnect google|erp`: revokes access and forgets the sign-in. */
export async function runDisconnect(service: string) {
  if (check(service) === "erp") {
    const url = await signOutErp();
    console.log(
      url
        ? `Disconnected from ${url}. Your task mappings stay in the config.`
        : "No ERP was connected.",
    );
    return;
  }
  const had = await signOutGoogle();
  const { configFile } = resolvePaths();
  const config = await loadConfig(configFile);
  if (config?.sources.some((s) => s.type === "google-calendar")) {
    await saveConfig(configFile, {
      ...config,
      sources: config.sources.filter((s) => s.type !== "google-calendar"),
    });
  }
  console.log(had ? "Disconnected from Google Calendar." : "Google Calendar wasn't connected.");
}
