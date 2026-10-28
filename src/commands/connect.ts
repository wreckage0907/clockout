import { homedir } from "node:os";
import {
  credentialsPath,
  loadErpCredentials,
  loadGoogleCredentials,
  loadMcpCredentials,
  type McpCredentials,
  removeErpCredentials,
  removeGoogleCredentials,
  removeMcpCredentials,
  saveErpCredentials,
  saveGoogleCredentials,
  saveMcpCredentials,
} from "../config/credentials";
import { withErpSite, withMcpServer, withSource } from "../config/edit";
import { loadConfig, saveConfig } from "../config/load";
import { resolvePaths, tildify } from "../config/paths";
import { type Config, isSafeSite, mcpServer } from "../config/schema";
import { cleanText } from "../core/text";
import { dayRange, localDate } from "../core/time";
import { clientFor, connectMcp, revokeMcp } from "../mcp";
import { openUrl } from "../open-url";
import { googleCalendar } from "../sources/google-calendar";
import { connectGoogle, googleClient, revoke } from "../sources/google-calendar/oauth";
import { WISPR_SERVER, WISPR_URL } from "../sources/wispr-flow";
import { connectErp, revokeErp, siteOrigin } from "../targets/next-pms/oauth";

/** Opens a URL in the default browser; the URL is printed too, in case that fails. */
const openInBrowser = (what: string) => async (url: string) => {
  console.log(
    `\nOpening ${what} sign-in in your browser. If it doesn't open, visit:\n\n  ${url}\n`,
  );
  await openUrl(url).catch((err: unknown) => {
    console.log(`Not opened: ${err instanceof Error ? err.message : String(err)}`);
  });
};

/**
 * MCP servers Clockout knows by name: their address, so nobody has to paste it, and the source
 * that reads from them once they're connected.
 */
const KNOWN_SERVERS: Record<string, { url: string; source?: "wispr-flow" }> = {
  wispr: { url: WISPR_URL, source: "wispr-flow" },
};

function check(service: string): "google" | "erp" | "mcp" {
  if (service === "google" || service === "erp") return service;
  if (/^[a-z][a-z0-9-]{0,31}$/.test(service)) return "mcp";
  throw new Error(
    `Connect "google" (your calendar), "erp" (where your timesheet goes) or an MCP server by a short lowercase name: clockout connect <name> <https://…/mcp>`,
  );
}

/**
 * `clockout connect google`: sign in once; Clockout reads your calendar from then on.
 * `clockout connect erp <url>`: sign in to your ERP so `clockout push` can fill your timesheet.
 * `clockout connect <name> [url]`: sign in to an MCP server, kept in `[[mcp]]`.
 */
export async function runConnect(service: string, url?: string) {
  const kind = check(service);
  if (kind === "erp") return connectErpSite(url);
  if (kind === "mcp") return connectMcpServer(service, url);
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
  const site = url ?? (config?.timesheet?.type === "command" ? undefined : config?.timesheet?.url);
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

async function connectMcpServer(name: string, url: string | undefined) {
  const { configFile } = resolvePaths();
  const config = await loadConfig(configFile);
  if (!config) throw new Error(`Run \`clockout init\` first, then \`clockout connect ${name}\`.`);
  const known = config.mcp.find((s) => s.name === name);
  const address = url?.trim() ?? known?.url ?? KNOWN_SERVERS[name]?.url;
  if (!address)
    throw new Error(
      `There's no MCP server called "${name}" in your config. Give its address: clockout connect ${name} https://example.com/mcp`,
    );
  const parsed = mcpServer.safeParse({ name, url: address });
  if (!parsed.success)
    throw new Error(`${name}: ${parsed.error.issues[0]?.message ?? "not a usable address"}.`);
  const server = parsed.data;
  console.log(
    `Clockout signs in to ${new URL(server.url).host} as you. It only calls the tools Clockout needs.`,
  );

  const signedIn = await connectMcp(name, server.url, openInBrowser(name));
  let creds: McpCredentials | null = signedIn;
  const client = await clientFor(server, {
    creds,
    save: async (next) => {
      creds = next;
    },
  });
  const info = await client.initialize();
  const tools = await client.listTools();

  if (creds) await saveMcpCredentials(name, creds);
  const reads = KNOWN_SERVERS[name]?.source;
  const next = {
    ...config,
    mcp: [...config.mcp.filter((s) => s.name !== name), server],
    sources:
      reads && !config.sources.some((s) => s.type === reads)
        ? [...config.sources, { type: reads, server: name }]
        : config.sources,
  };
  if (!known || known.url !== server.url || next.sources !== config.sources)
    await saveConfig(configFile, next);
  const names = tools.map((t) => cleanText(t.name)).filter(Boolean);
  const shown = names.length > 8 ? `${names.slice(0, 8).join(", ")}, …` : names.join(", ");
  console.log(
    `Connected to ${name} (${info.name}). It offers ${names.length} tool${names.length === 1 ? "" : "s"}${shown ? `: ${shown}` : ""}.`,
  );
  if (reads && next.sources !== config.sources)
    console.log("Clockout reads your recorded meetings from it too, and asks nothing about them.");
  console.log(
    signedIn
      ? `The sign-in is kept in ${tildify(credentialsPath(), homedir())} (only you can read it).`
      : "It didn't ask for a sign-in.",
  );
}

/** Signs in to the MCP server called `name` (see `src/mcp/`), adding it to the config. */
export async function signInMcp(
  name: string,
  url: string,
  config: Config,
  open: (url: string) => Promise<void>,
): Promise<Config> {
  const creds = await connectMcp(name, url, open);
  if (creds) await saveMcpCredentials(name, creds);
  const server = mcpServer.parse({ name, url });
  const withServer = withMcpServer(config, server);
  // Only the recorder's own server brings a source with it; any other server is just a tool.
  if (name !== WISPR_SERVER) return withServer;
  const known = config.sources.some((s) => s.type === "wispr-flow" && s.server === name);
  return known ? withServer : withSource(withServer, { type: "wispr-flow", server: name }, true);
}

/** Revokes an MCP server's sign-in and forgets it; the server stays in `[[mcp]]`. */
export async function signOutMcp(name: string): Promise<boolean> {
  const creds = await loadMcpCredentials(name);
  if (creds) await revokeMcp(creds);
  await removeMcpCredentials(name);
  return creds !== null;
}

/** `clockout disconnect google|erp|<name>`: revokes access and forgets the sign-in. */
export async function runDisconnect(service: string) {
  if (check(service) === "mcp") {
    const had = await signOutMcp(service);
    console.log(
      had
        ? `Disconnected from ${service}. It stays in your config's [[mcp]] list until you remove it.`
        : `${service} wasn't connected.`,
    );
    return;
  }
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
