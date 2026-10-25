import { z } from "zod";
import { cleanText } from "../core/text";
import type { Fetch } from "../oauth";

// A small MCP client: JSON-RPC over streamable HTTP, only what Clockout uses (initialize,
// tools/list, tools/call). Written here rather than taken from the SDK (ADR 0009). What a server
// says (tool descriptions, results, errors) is data, never instructions.

export const PROTOCOL_VERSION = "2025-06-18";

/** The server refused the sign-in (or wants one and there is none). */
export class McpAuthError extends Error {
  constructor(
    message: string,
    /** The `WWW-Authenticate` header, for finding where to sign in. */
    readonly challenge: string | null,
  ) {
    super(message);
  }
}

/** A tool answered with `isError`: that system's own error, in its words. */
export class McpToolError extends Error {}

const rpcError = z.object({ code: z.number(), message: z.string() });
const rpcReply = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]),
  result: z.unknown().optional(),
  error: rpcError.optional(),
});

const initializeResult = z.object({
  protocolVersion: z.string(),
  serverInfo: z.object({ name: z.string(), version: z.string().optional() }).optional(),
});

const tool = z.object({
  name: z.string(),
  description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
});
export type McpTool = z.infer<typeof tool>;

const toolList = z.object({ tools: z.array(tool), nextCursor: z.string().optional() });

const callResult = z.object({
  content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })).default([]),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
});

export interface McpClientOptions {
  url: string;
  /** How the server is named to you, e.g. "wispr". */
  name: string;
  /** A current access token; `force` asks for a fresh one after a 401. None: no sign-in. */
  token?: (force?: boolean) => Promise<string>;
  fetch?: Fetch;
  timeoutMs?: number;
  /** Sent as clientInfo.version. */
  version?: string;
}

export interface McpClient {
  /** Starts the session; done once, on the first call that needs it. */
  initialize(): Promise<{ name: string; version?: string | undefined }>;
  listTools(): Promise<McpTool[]>;
  /** A tool's answer: `structuredContent`, else its text parsed as JSON, else the text. */
  callTool(name: string, args?: Record<string, unknown>): Promise<unknown>;
}

export function mcpClient(opts: McpClientOptions): McpClient {
  const doFetch = opts.fetch ?? fetch;
  const host = new URL(opts.url).host;
  let session: string | undefined;
  let version: string | undefined;
  let started: Promise<{ name: string; version?: string | undefined }> | null = null;
  let nextId = 1;

  async function send(message: object, retried = false): Promise<Response> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (version) headers["mcp-protocol-version"] = version;
    if (session) headers["mcp-session-id"] = session;
    if (opts.token) headers.authorization = `Bearer ${await opts.token(retried)}`;
    const res = await doFetch(opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
    }).catch((err: unknown) => {
      throw new Error(`Couldn't reach ${opts.name} at ${host}. Check your connection.`, {
        cause: err,
      });
    });
    if (res.status === 401) {
      await res.body?.cancel();
      if (opts.token && !retried) return send(message, true);
      throw new McpAuthError(
        opts.token
          ? `${opts.name} turned down the sign-in. Run \`clockout connect ${opts.name}\` again.`
          : `${opts.name} needs a sign-in. Run \`clockout connect ${opts.name}\`.`,
        res.headers.get("www-authenticate"),
      );
    }
    return res;
  }

  async function request(method: string, params: object, again = true): Promise<unknown> {
    const id = nextId++;
    const res = await send({ jsonrpc: "2.0", id, method, params });
    // A session the server has forgotten: start a new one, once (streamable HTTP spec).
    if (res.status === 404 && session && method !== "initialize" && again) {
      await res.body?.cancel();
      session = undefined;
      started = null;
      await initialize();
      return request(method, params, false);
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(`${opts.name} answered HTTP ${res.status} to ${method}.`);
    }
    if (method === "initialize") session = res.headers.get("mcp-session-id") ?? undefined;
    const reply = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? await fromStream(res, id)
      : await res.json().catch(() => null);
    const parsed = rpcReply.safeParse(reply);
    if (!parsed.success || parsed.data.id !== id)
      throw new Error(`${opts.name} sent an answer to ${method} that isn't MCP.`);
    if (parsed.data.error)
      throw new Error(`${opts.name}: ${clip(parsed.data.error.message)} (${method}).`);
    return parsed.data.result;
  }

  async function notify(method: string): Promise<void> {
    const res = await send({ jsonrpc: "2.0", method });
    await res.body?.cancel();
  }

  function initialize() {
    started ??= (async () => {
      const result = initializeResult.safeParse(
        await request("initialize", {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "clockout", version: opts.version ?? "0.0.0" },
        }),
      );
      if (!result.success)
        throw new Error(`${opts.name} didn't start an MCP session the way the protocol says.`);
      version = result.data.protocolVersion;
      await notify("notifications/initialized");
      const info = result.data.serverInfo;
      return { name: cleanText(info?.name ?? opts.name), version: info?.version };
    })().catch((err: unknown) => {
      started = null;
      throw err;
    });
    return started;
  }

  return {
    initialize,
    async listTools() {
      await initialize();
      const tools: McpTool[] = [];
      let cursor: string | undefined;
      do {
        const page = toolList.safeParse(await request("tools/list", cursor ? { cursor } : {}));
        if (!page.success) throw new Error(`${opts.name} sent a tool list Clockout can't read.`);
        tools.push(...page.data.tools);
        cursor = page.data.nextCursor;
      } while (cursor && tools.length < 1000);
      return tools;
    },
    async callTool(name, args = {}) {
      await initialize();
      const result = callResult.safeParse(await request("tools/call", { name, arguments: args }));
      if (!result.success)
        throw new Error(`${opts.name} sent an answer from ${name} Clockout can't read.`);
      const text = result.data.content
        .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
        .join("\n");
      if (result.data.isError)
        throw new McpToolError(`${opts.name}: ${clip(text) || `${name} failed`}`);
      if (result.data.structuredContent !== undefined) return result.data.structuredContent;
      try {
        return JSON.parse(text) as unknown;
      } catch {
        return text;
      }
    },
  };
}

/** A server's own words, on one line and not too long. */
function clip(text: string): string {
  const line = cleanText(text);
  return line.length > 300 ? `${line.slice(0, 299)}…` : line;
}

/** Reads server-sent events until the reply with this id; notifications on the way are skipped. */
async function fromStream(res: Response, id: number): Promise<unknown> {
  if (!res.body) return null;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buffer += value.replace(/\r\n?/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end >= 0 || (done && buffer.trim())) {
        const event = end >= 0 ? buffer.slice(0, end) : buffer;
        buffer = end >= 0 ? buffer.slice(end + 2) : "";
        const data = event
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) {
          const message = (() => {
            try {
              return JSON.parse(data) as unknown;
            } catch {
              return null;
            }
          })();
          if (message && typeof message === "object" && "id" in message && message.id === id)
            return message;
        }
        end = buffer.indexOf("\n\n");
      }
      if (done) return null;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
