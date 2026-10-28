import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { withLock } from "../lock";
import { resolvePaths } from "./paths";

const googleCredentials = z.object({
  refresh_token: z.string().min(1),
  /** The Google account that connected, for display. */
  email: z.string().optional(),
  client_id: z.string().min(1),
  scope: z.string(),
  connected_at: z.string(),
});
export type GoogleCredentials = z.infer<typeof googleCredentials>;

const mcpCredentials = z.object({
  /** The MCP server's address this sign-in is for; a changed address needs a new sign-in. */
  url: z.string().min(1),
  /** The protected resource the tokens are for (RFC 8707). */
  resource: z.string().min(1),
  token_endpoint: z.string().min(1),
  revocation_endpoint: z.string().optional(),
  /** The public OAuth client Clockout registered with that server. */
  client_id: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  access_token: z.string().min(1),
  /** When the access token stops working (ISO time); without it, until the server says so. */
  expires_at: z.string().optional(),
  connected_at: z.string(),
});
export type McpCredentials = z.infer<typeof mcpCredentials>;

// An `erp` key from before the next-pms target was removed is ignored (and dropped on the next write).
const file = z.object({
  google: googleCredentials.optional(),
  /** By the name in `[[mcp]]`. */
  mcp: z.record(z.string(), mcpCredentials).optional(),
});
type CredentialsFile = z.infer<typeof file>;

/** Next to config.toml, readable only by you. Holds sign-in tokens, never shown or logged. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(resolvePaths(env).configFile), "credentials.json");
}

async function read(path: string): Promise<CredentialsFile> {
  try {
    const parsed = file.safeParse(JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export async function loadGoogleCredentials(
  path = credentialsPath(),
): Promise<GoogleCredentials | null> {
  return (await read(path)).google ?? null;
}

export async function saveGoogleCredentials(
  creds: GoogleCredentials,
  path = credentialsPath(),
): Promise<void> {
  await write(path, { ...(await read(path)), google: creds });
}

export async function removeGoogleCredentials(path = credentialsPath()): Promise<void> {
  const { google: _, ...rest } = await read(path);
  await write(path, rest);
}

export async function loadMcpCredentials(
  name: string,
  path = credentialsPath(),
): Promise<McpCredentials | null> {
  return (await read(path)).mcp?.[name] ?? null;
}

export async function saveMcpCredentials(
  name: string,
  creds: McpCredentials,
  path = credentialsPath(),
): Promise<void> {
  const current = await read(path);
  await write(path, { ...current, mcp: { ...current.mcp, [name]: creds } });
}

export async function removeMcpCredentials(name: string, path = credentialsPath()): Promise<void> {
  const { mcp, ...rest } = await read(path);
  const { [name]: _, ...others } = mcp ?? {};
  await write(path, Object.keys(others).length ? { ...rest, mcp: others } : rest);
}

/**
 * Saves the file readable only by you, or removes it when nothing is left. One writer at a time:
 * a scheduled run and your own can both be refreshing a rotating token.
 */
async function write(path: string, creds: CredentialsFile): Promise<void> {
  await withLock(`${path}.lock`, () => writeNow(path, creds));
}

async function writeNow(path: string, creds: CredentialsFile): Promise<void> {
  if (Object.keys(creds).length === 0) return rm(path, { force: true });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
}
