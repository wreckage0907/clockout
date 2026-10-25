import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

// A remote MCP server, kept in memory, signing in the way MCP's authorization spec says: a 401
// pointing to protected-resource metadata, an authorization server under /auth with dynamic
// client registration, PKCE, refresh-token rotation and revocation. Its tools are a meeting
// recorder's (list_meetings, get_meeting) and a notes app's (write_note), plus one that always
// fails. The tests run Clockout against it, and you can run it by hand:
//
//   pnpm mock-mcp [--port 4200]
//
// Signing in approves at once (no page to click through), unless `deny` is set.
// Only node: imports, so Node runs this file as it is (type stripping).

export interface MockMeeting {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  calendar_event_id?: string;
  summary: string;
}

export interface MockNote {
  title: string;
  content: string;
}

export interface MockMcpOptions {
  port?: number;
  /** Seconds an access token lasts. */
  tokenLife?: number;
  /** Turns every sign-in down with access_denied. */
  deny?: boolean;
  /** No sign-in at all: the MCP endpoint answers anyone. */
  open?: boolean;
  meetings?: MockMeeting[];
}

export const DEFAULT_MEETINGS: MockMeeting[] = [
  {
    id: "rec-1",
    title: "Daily standup",
    start: "2026-10-16T04:30:00Z",
    end: "2026-10-16T04:47:00Z",
    attendees: ["dev@example.com", "lead@example.com"],
    calendar_event_id: "standup-1",
    summary: "Went through yesterday's deploy.",
  },
  {
    id: "rec-2",
    title: "Design review",
    start: "2026-10-16T09:00:00Z",
    end: "2026-10-16T09:52:00Z",
    attendees: ["dev@example.com", "design@example.com"],
    summary: "Agreed on the new card layout.",
  },
];

const TOOLS = [
  {
    name: "list_meetings",
    description: "Recorded meetings between two times.",
    inputSchema: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    },
  },
  {
    name: "get_meeting",
    description: "One recorded meeting.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "write_note",
    description: "Adds a note.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, content: { type: "string" } },
      required: ["title", "content"],
    },
  },
  {
    name: "always_fails",
    description: "Answers with an error.",
    inputSchema: { type: "object", properties: {} },
  },
];

export interface MockMcpRequest {
  path: string;
  /** The JSON-RPC method, for calls to the MCP endpoint. */
  method?: string;
  auth: string | undefined;
  body: string;
}

type Reply = {
  status: number;
  json?: unknown;
  headers?: Record<string, string>;
  /** Sent as one server-sent event (and a notification before it). */
  sse?: unknown;
};

const sha256 = (s: string) => createHash("sha256").update(s).digest("base64url");
const token = (prefix: string) => `${prefix}-${randomBytes(9).toString("base64url")}`;

export async function startMockMcp(opts: MockMcpOptions = {}) {
  const meetings = opts.meetings ?? DEFAULT_MEETINGS;
  const notes: MockNote[] = [];
  const requests: MockMcpRequest[] = [];
  const clients = new Map<string, string[]>();
  const codes = new Map<
    string,
    { client: string; challenge: string; redirect: string; resource: string }
  >();
  const access = new Map<string, number>();
  const refresh = new Map<string, string>();
  const sessions = new Set<string>();
  const revoked: string[] = [];
  let origin = "";
  let tokenLife = opts.tokenLife ?? 3600;

  const mcpUrl = () => `${origin}/mcp`;
  const issuer = () => `${origin}/auth`;

  function issue(client: string): Record<string, unknown> {
    const at = token("at");
    const rt = token("rt");
    access.set(at, Date.now() + tokenLife * 1000);
    refresh.set(rt, client);
    return { access_token: at, token_type: "Bearer", expires_in: tokenLife, refresh_token: rt };
  }

  function oauth(method: string, url: URL, form: URLSearchParams, raw: string): Reply | null {
    const p = url.pathname;
    if (p === "/.well-known/oauth-protected-resource/mcp")
      return {
        status: 200,
        json: {
          resource: mcpUrl(),
          authorization_servers: [issuer()],
          scopes_supported: ["meetings", "notes"],
        },
      };
    if (p === "/.well-known/oauth-authorization-server/auth")
      return {
        status: 200,
        json: {
          issuer: issuer(),
          authorization_endpoint: `${issuer()}/authorize`,
          token_endpoint: `${issuer()}/token`,
          registration_endpoint: `${issuer()}/register`,
          revocation_endpoint: `${issuer()}/revoke`,
          code_challenge_methods_supported: ["S256"],
        },
      };
    if (p === "/auth/register" && method === "POST") {
      const body = JSON.parse(raw || "{}") as { redirect_uris?: string[] };
      if (!body.redirect_uris?.length)
        return { status: 400, json: { error: "invalid_redirect_uri" } };
      const id = token("client");
      clients.set(id, body.redirect_uris);
      return { status: 201, json: { client_id: id, redirect_uris: body.redirect_uris } };
    }
    if (p === "/auth/authorize" && method === "GET") {
      const q = url.searchParams;
      const client = q.get("client_id") ?? "";
      const redirect = q.get("redirect_uri") ?? "";
      if (!clients.get(client)?.includes(redirect))
        return { status: 400, json: { error: "invalid_request" } };
      const back = new URL(redirect);
      back.searchParams.set("state", q.get("state") ?? "");
      if (opts.deny) back.searchParams.set("error", "access_denied");
      else if (q.get("code_challenge_method") !== "S256" || !q.get("code_challenge"))
        back.searchParams.set("error", "invalid_request");
      else if (q.get("resource") !== mcpUrl()) back.searchParams.set("error", "invalid_target");
      else {
        const code = token("code");
        codes.set(code, {
          client,
          challenge: q.get("code_challenge") ?? "",
          redirect,
          resource: q.get("resource") ?? "",
        });
        back.searchParams.set("code", code);
      }
      return { status: 302, headers: { location: back.href } };
    }
    if (p === "/auth/token" && method === "POST") {
      const grant = form.get("grant_type");
      if (form.get("resource") !== mcpUrl())
        return { status: 400, json: { error: "invalid_target" } };
      if (grant === "authorization_code") {
        const c = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        if (
          !c ||
          c.client !== form.get("client_id") ||
          c.redirect !== form.get("redirect_uri") ||
          c.challenge !== sha256(form.get("code_verifier") ?? "")
        )
          return { status: 400, json: { error: "invalid_grant" } };
        return { status: 200, json: issue(c.client) };
      }
      if (grant === "refresh_token") {
        const rt = form.get("refresh_token") ?? "";
        const client = refresh.get(rt);
        if (!client || client !== form.get("client_id"))
          return { status: 400, json: { error: "invalid_grant" } };
        refresh.delete(rt);
        return { status: 200, json: issue(client) };
      }
      return { status: 400, json: { error: "unsupported_grant_type" } };
    }
    if (p === "/auth/revoke" && method === "POST") {
      const t = form.get("token") ?? "";
      revoked.push(t);
      refresh.delete(t);
      access.delete(t);
      return { status: 200, json: {} };
    }
    return null;
  }

  function rpc(message: Record<string, unknown>, session: string | undefined): Reply {
    const id = message.id;
    const params = (message.params ?? {}) as Record<string, unknown>;
    const ok = (result: unknown, extra: Partial<Reply> = {}): Reply => ({
      status: 200,
      json: { jsonrpc: "2.0", id, result },
      ...extra,
    });
    if (message.method === "initialize") {
      const s = token("session");
      sessions.add(s);
      return ok(
        {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "Mock Meetings", version: "1.0.0" },
        },
        { headers: { "mcp-session-id": s } },
      );
    }
    if (!session || !sessions.has(session))
      return { status: session ? 404 : 400, json: { error: "unknown session" } };
    if (id === undefined) return { status: 202 };
    if (message.method === "tools/list") {
      // Two pages, so clients have to follow the cursor.
      return params.cursor === "2"
        ? ok({ tools: TOOLS.slice(2) })
        : ok({ tools: TOOLS.slice(0, 2), nextCursor: "2" });
    }
    if (message.method === "tools/call") {
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const text = (t: string, isError = false) => ({
        content: [{ type: "text", text: t }],
        ...(isError ? { isError } : {}),
      });
      let result: unknown;
      switch (params.name) {
        case "list_meetings": {
          const from = Date.parse(String(args.from));
          const to = Date.parse(String(args.to));
          const found = meetings
            .filter((m) => Date.parse(m.start) < to && Date.parse(m.end) > from)
            .map(({ summary: _, ...m }) => m);
          result = {
            ...text(JSON.stringify({ meetings: found })),
            structuredContent: { meetings: found },
          };
          break;
        }
        case "get_meeting": {
          const m = meetings.find((x) => x.id === args.id);
          result = m ? text(JSON.stringify(m)) : text(`No meeting ${String(args.id)}.`, true);
          break;
        }
        case "write_note": {
          if (typeof args.title !== "string" || typeof args.content !== "string") {
            result = text("title and content must be text", true);
            break;
          }
          notes.push({ title: args.title, content: args.content });
          result = text(`Saved "${args.title}".`);
          break;
        }
        case "always_fails":
          result = text("The notes service is down for maintenance.", true);
          break;
        default:
          return {
            status: 200,
            json: {
              jsonrpc: "2.0",
              id,
              error: { code: -32602, message: `Unknown tool: ${String(params.name)}` },
            },
          };
      }
      // Tool calls answer as a stream, the other half of streamable HTTP.
      return { status: 200, sse: { jsonrpc: "2.0", id, result } };
    }
    return {
      status: 200,
      json: { jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } },
    };
  }

  function mcp(req: IncomingMessage, raw: string): Reply {
    if (req.method !== "POST") return { status: 405 };
    if (!opts.open) {
      const auth = req.headers.authorization ?? "";
      const until = access.get(auth.replace(/^Bearer /, ""));
      if (!until || until < Date.now())
        return {
          status: 401,
          json: { error: "invalid_token" },
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="meetings notes"`,
          },
        };
    }
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return {
        status: 400,
        json: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      };
    }
    const session = req.headers["mcp-session-id"];
    return rpc(message, typeof session === "string" ? session : undefined);
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", origin);
      let method: string | undefined;
      if (url.pathname === "/mcp") {
        try {
          method = (JSON.parse(raw) as { method?: string }).method;
        } catch {
          method = undefined;
        }
      }
      requests.push({ path: url.pathname, method, auth: req.headers.authorization, body: raw });
      const reply: Reply =
        url.pathname === "/mcp"
          ? mcp(req, raw)
          : (oauth(req.method ?? "GET", url, new URLSearchParams(raw), raw) ?? {
              status: 404,
              json: { error: "not_found" },
            });
      if (reply.sse !== undefined) {
        res.writeHead(reply.status, { "content-type": "text/event-stream", ...reply.headers });
        res.write(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } })}\n\n`,
        );
        res.end(`event: message\ndata: ${JSON.stringify(reply.sse)}\n\n`);
        return;
      }
      res.writeHead(reply.status, {
        ...(reply.json === undefined ? {} : { "content-type": "application/json" }),
        ...reply.headers,
      });
      res.end(reply.json === undefined ? undefined : JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url: mcpUrl(),
    origin,
    meetings,
    notes,
    requests,
    revoked,
    /** Calls to a tool, by name. */
    calls: (tool: string) =>
      requests.filter(
        (r) =>
          r.method === "tools/call" &&
          (JSON.parse(r.body) as { params: { name: string } }).params.name === tool,
      ),
    /** Forgets every session, as a restarted server would. */
    dropSessions: () => sessions.clear(),
    /** Every access token handed out so far stops working. */
    expireTokens: () => access.clear(),
    setTokenLife: (seconds: number) => {
      tokenLife = seconds;
    },
    stop: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

export type MockMcp = Awaited<ReturnType<typeof startMockMcp>>;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf("--port");
  const mock = await startMockMcp({ port: Number(i > 0 ? process.argv[i + 1] : 4200) });
  console.log(`Mock MCP server on ${mock.url} (Ctrl+C stops it; everything is kept in memory)

In ~/.config/clockout/config.toml:

[[mcp]]
name = "mock"
url = "${mock.url}"

Then: clockout connect mock`);
}
