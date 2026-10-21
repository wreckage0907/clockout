import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
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

const erpCredentials = z.object({
  /** The site's origin, e.g. "https://erp.example.com". */
  url: z.string().min(1),
  /** The public OAuth client Clockout registered on that site. */
  client_id: z.string().min(1),
  refresh_token: z.string().min(1),
  /** The ERP user that connected, for display. */
  user: z.string().optional(),
  connected_at: z.string(),
});
export type ErpCredentials = z.infer<typeof erpCredentials>;

const file = z.object({
  google: googleCredentials.optional(),
  erp: erpCredentials.optional(),
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

export async function loadErpCredentials(path = credentialsPath()): Promise<ErpCredentials | null> {
  return (await read(path)).erp ?? null;
}

export async function saveErpCredentials(
  creds: ErpCredentials,
  path = credentialsPath(),
): Promise<void> {
  await write(path, { ...(await read(path)), erp: creds });
}

export async function removeErpCredentials(path = credentialsPath()): Promise<void> {
  const { erp: _, ...rest } = await read(path);
  await write(path, rest);
}

/** Saves the file readable only by you, or removes it when nothing is left. */
async function write(path: string, creds: CredentialsFile): Promise<void> {
  if (Object.keys(creds).length === 0) return rm(path, { force: true });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
}
