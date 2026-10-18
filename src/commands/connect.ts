import { homedir } from "node:os";
import { execa } from "execa";
import {
  credentialsPath,
  loadGoogleCredentials,
  removeGoogleCredentials,
  saveGoogleCredentials,
} from "../config/credentials";
import { loadConfig, saveConfig } from "../config/load";
import { resolvePaths, tildify } from "../config/paths";
import type { Config } from "../config/schema";
import { dayRange, localDate } from "../core/time";
import { googleCalendar } from "../sources/google-calendar";
import { connectGoogle, googleClient, revoke } from "../sources/google-calendar/oauth";

/** Opens a URL in the default browser; the URL is printed too, in case that fails. */
async function openInBrowser(url: string): Promise<void> {
  console.log(`\nOpening Google sign-in in your browser. If it doesn't open, visit:\n\n  ${url}\n`);
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  await execa(cmd, args as string[]).catch(() => undefined);
}

function check(service: string) {
  if (service !== "google") throw new Error(`Only "google" can be connected so far.`);
}

/** `clockout connect google`: sign in once; Clockout reads your calendar from then on. */
export async function runConnect(service: string) {
  check(service);
  const { configFile } = resolvePaths();
  const config = await loadConfig(configFile);
  const client = googleClient(config);

  console.log("Clockout asks for read-only access to your calendar events, nothing else.");
  const { refreshToken, scope } = await connectGoogle(client, openInBrowser);
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

/** `clockout disconnect google`: revokes access and forgets the sign-in. */
export async function runDisconnect(service: string) {
  check(service);
  const creds = await loadGoogleCredentials();
  if (creds) await revoke(creds.refresh_token);
  await removeGoogleCredentials();
  const { configFile } = resolvePaths();
  const config = await loadConfig(configFile);
  if (config?.sources.some((s) => s.type === "google-calendar")) {
    await saveConfig(configFile, {
      ...config,
      sources: config.sources.filter((s) => s.type !== "google-calendar"),
    });
  }
  console.log(creds ? "Disconnected from Google Calendar." : "Google Calendar wasn't connected.");
}
