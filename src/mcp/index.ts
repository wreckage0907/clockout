import pkg from "../../package.json" with { type: "json" };
import {
  loadMcpCredentials,
  type McpCredentials,
  saveMcpCredentials,
  withMcpCredentials,
} from "../config/credentials";
import type { McpServer } from "../config/schema";
import type { Fetch } from "../oauth";
import { type McpClient, mcpClient } from "./client";
import { mcpAuth } from "./oauth";

export { McpAuthError, type McpClient, type McpTool, McpToolError, mcpClient } from "./client";
export { connectMcp, mcpAuth, revokeMcp } from "./oauth";

/**
 * A client for a server in `[[mcp]]`, signed in with what `clockout connect <name>` saved.
 * A server that was never connected is called without a sign-in (some need none).
 */
export async function clientFor(
  server: McpServer,
  opts: {
    fetch?: Fetch;
    creds?: McpCredentials | null;
    save?: (next: McpCredentials) => Promise<void>;
  } = {},
): Promise<McpClient> {
  const creds = opts.creds === undefined ? await loadMcpCredentials(server.name) : opts.creds;
  if (creds && creds.url !== server.url)
    throw new Error(
      `${server.name}'s address changed since you signed in. Run \`clockout connect ${server.name}\` again.`,
    );
  const save = opts.save ?? ((next: McpCredentials) => saveMcpCredentials(server.name, next));
  return mcpClient({
    url: server.url,
    name: server.name,
    version: pkg.version,
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(creds
      ? {
          token: mcpAuth(
            server.name,
            creds,
            save,
            opts.fetch,
            // Saving to the credentials file: refresh under its lock, from what's saved now.
            // A caller with its own `save` (the sign-in flow) hasn't written the file yet.
            opts.save ? undefined : (fn) => withMcpCredentials(server.name, fn),
          ),
        }
      : {}),
  });
}
