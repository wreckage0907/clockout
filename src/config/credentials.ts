import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { withLock } from "../lock";
import { resolvePaths, tildify } from "./paths";

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

/**
 * The file as saved: `google` and `mcp` (by the name in `[[mcp]]`). Entries are checked
 * one at a time when read, and carried through untouched when another entry is saved, so one
 * that doesn't fit never costs you the others.
 */
type Raw = Record<string, unknown>;

/** Next to config.toml, readable only by you. Holds sign-in tokens, never shown or logged. */
export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(resolvePaths(env).configFile), "credentials.json");
}

/**
 * The file as saved, or {} when there isn't one. A file that's there but can't be read is an
 * error, never "empty": the next save would write over every other sign-in.
 */
async function read(path: string): Promise<Raw> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw unreadable(path, "it couldn't be read", err);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw unreadable(path, "it isn't valid JSON", err);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw unreadable(
      path,
      "it isn't a JSON object",
      new Error("credentials file root is not an object"),
    );
  return parsed as Raw;
}

function unreadable(path: string, why: string, cause: unknown): Error {
  return new Error(
    `Can't read your saved sign-ins in ${tildify(path)}: ${why}. Nothing was changed. Fix the file, or delete it and run \`clockout connect\` again for each service you had connected.`,
    { cause },
  );
}

/** One entry, or null when it's missing or doesn't fit; the others are unaffected. */
function entry<T>(schema: z.ZodType<T>, value: unknown): T | null {
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function mcpEntries(raw: Raw): Raw {
  const m = raw.mcp;
  return typeof m === "object" && m !== null && !Array.isArray(m) ? (m as Raw) : {};
}

export async function loadGoogleCredentials(
  path = credentialsPath(),
): Promise<GoogleCredentials | null> {
  return entry(googleCredentials, (await read(path)).google);
}

export async function saveGoogleCredentials(
  creds: GoogleCredentials,
  path = credentialsPath(),
): Promise<void> {
  await update(path, (raw) => ({ ...raw, google: creds }));
}

export async function removeGoogleCredentials(path = credentialsPath()): Promise<void> {
  await update(path, ({ google: _, ...rest }) => rest);
}

export async function loadMcpCredentials(
  name: string,
  path = credentialsPath(),
): Promise<McpCredentials | null> {
  return entry(mcpCredentials, mcpEntries(await read(path))[name]);
}

export async function saveMcpCredentials(
  name: string,
  creds: McpCredentials,
  path = credentialsPath(),
): Promise<void> {
  await update(path, (raw) => withMcp(raw, name, creds));
}

export async function removeMcpCredentials(name: string, path = credentialsPath()): Promise<void> {
  await update(path, (raw) => withMcp(raw, name, null));
}

/**
 * Runs `fn` with the saved sign-in for `name` while holding the credentials lock, so a refresh
 * can start from what's on disk now (a scheduled run may have rotated the token since this
 * process started) and save its result with nobody else's write landing in between. `save`
 * writes without taking the lock again.
 */
export async function withMcpCredentials<T>(
  name: string,
  fn: (stored: McpCredentials | null, save: (next: McpCredentials) => Promise<void>) => Promise<T>,
  path = credentialsPath(),
): Promise<T> {
  return withLock(`${path}.lock`, async () => {
    const raw = await read(path);
    return fn(entry(mcpCredentials, mcpEntries(raw)[name]), (next) =>
      writeNow(path, withMcp(raw, name, next)),
    );
  });
}

function withMcp(raw: Raw, name: string, creds: McpCredentials | null): Raw {
  const { mcp: _, ...rest } = raw;
  const { [name]: __, ...others } = mcpEntries(raw);
  const next = creds ? { ...others, [name]: creds } : others;
  return Object.keys(next).length ? { ...rest, mcp: next } : rest;
}

/**
 * Read, change, write: all under one lock, so a scheduled run and your own can't each read the
 * file, then each write it back and undo the other's change (a rotated refresh token, say).
 */
async function update(path: string, change: (raw: Raw) => Raw): Promise<void> {
  await withLock(`${path}.lock`, async () => {
    // An `erp` sign-in from before the next-pms target was removed (ADR 0013) is dropped here.
    const { erp: _, ...raw } = await read(path);
    await writeNow(path, change(raw));
  });
}

/**
 * Saves the file readable only by you, or removes it when nothing is left. Written whole to a
 * private temp file next to it and renamed into place, so a reader sees the old file or the new
 * one, never half of either. Call with the lock held.
 */
async function writeNow(path: string, creds: Raw): Promise<void> {
  if (Object.keys(creds).length === 0) return rm(path, { force: true });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temp, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(creds, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (err) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw err;
  }
}
