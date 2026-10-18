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

const file = z.object({ google: googleCredentials.optional() });
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
  const current = await read(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify({ ...current, google: creds }, null, 2)}\n`, {
    mode: 0o600,
  });
}

export async function removeGoogleCredentials(path = credentialsPath()): Promise<void> {
  const { google: _, ...rest } = await read(path);
  if (Object.keys(rest).length === 0) await rm(path, { force: true });
  else await writeFile(path, `${JSON.stringify(rest, null, 2)}\n`, { mode: 0o600 });
}
