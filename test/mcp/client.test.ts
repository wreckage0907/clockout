import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { McpAuthError, McpToolError, mcpClient } from "../../src/mcp/client";
import { type MockMcp, startMockMcp } from "../mock-mcp/server";

describe("MCP client", () => {
  let mock: MockMcp;
  beforeAll(async () => {
    mock = await startMockMcp({ open: true });
  });
  afterAll(() => mock.stop());

  const client = () => mcpClient({ url: mock.url, name: "notes", version: "1.2.3" });

  it("starts a session and says initialized before anything else", async () => {
    const before = mock.requests.length;
    const c = client();
    expect(await c.initialize()).toEqual({ name: "Mock Meetings", version: "1.0.0" });
    const sent = mock.requests.slice(before);
    expect(sent.map((r) => r.method)).toEqual(["initialize", "notifications/initialized"]);
    expect(JSON.parse(sent[0]?.body ?? "")).toMatchObject({
      params: { clientInfo: { name: "clockout", version: "1.2.3" }, capabilities: {} },
    });
  });

  it("lists every tool, following the cursor, in one session", async () => {
    const before = mock.requests.length;
    const tools = await client().listTools();
    expect(tools.map((t) => t.name)).toEqual([
      "list_meetings",
      "get_meeting",
      "write_note",
      "always_fails",
    ]);
    const sent = mock.requests.slice(before);
    expect(sent.filter((r) => r.method === "initialize")).toHaveLength(1);
    expect(sent.filter((r) => r.method === "tools/list")).toHaveLength(2);
  });

  it("reads structuredContent from a streamed answer, skipping notifications", async () => {
    const answer = await client().callTool("list_meetings", {
      from: "2026-10-16T00:00:00Z",
      to: "2026-10-16T06:00:00Z",
    });
    expect(answer).toEqual({
      meetings: [expect.objectContaining({ id: "rec-1", title: "Daily standup" })],
    });
  });

  it("parses JSON text when there's no structuredContent", async () => {
    expect(await client().callTool("get_meeting", { id: "rec-2" })).toMatchObject({
      title: "Design review",
      summary: "Agreed on the new card layout.",
    });
  });

  it("keeps plain text as it is", async () => {
    expect(await client().callTool("write_note", { title: "Day", content: "Shipped" })).toBe(
      'Saved "Day".',
    );
    expect(mock.notes).toEqual([{ title: "Day", content: "Shipped" }]);
  });

  it("shows a tool's isError as that system's error", async () => {
    const err = await client()
      .callTool("always_fails")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as Error).message).toBe("notes: The notes service is down for maintenance.");
  });

  it("names a JSON-RPC error", async () => {
    await expect(client().callTool("nope")).rejects.toThrow(
      "notes: Unknown tool: nope (tools/call).",
    );
  });

  it("starts a new session when the server forgot the old one", async () => {
    const c = client();
    await c.initialize();
    mock.dropSessions();
    expect(await c.callTool("get_meeting", { id: "rec-1" })).toMatchObject({ id: "rec-1" });
  });

  it("sends the session id and protocol version after initialize", async () => {
    const seen: Headers[] = [];
    const c = mcpClient({
      url: mock.url,
      name: "notes",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push(new Headers(init?.headers));
        return fetch(input, init);
      }) as typeof fetch,
    });
    await c.listTools();
    expect(seen[0]?.get("mcp-session-id")).toBeNull();
    expect(seen[1]?.get("mcp-session-id")).toMatch(/^session-/);
    expect(seen[1]?.get("mcp-protocol-version")).toBe("2025-06-18");
    expect(seen[0]?.get("accept")).toBe("application/json, text/event-stream");
  });

  it("says when it can't reach the server", async () => {
    const c = mcpClient({ url: "http://127.0.0.1:9/mcp", name: "notes", timeoutMs: 2000 });
    await expect(c.initialize()).rejects.toThrow("Couldn't reach notes at 127.0.0.1:9.");
  });
});

describe("MCP client and sign-in", () => {
  let mock: MockMcp;
  beforeAll(async () => {
    mock = await startMockMcp();
  });
  afterAll(() => mock.stop());

  it("asks for a sign-in when the server answers 401, keeping the challenge", async () => {
    const err = await mcpClient({ url: mock.url, name: "wispr" })
      .initialize()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(McpAuthError);
    expect((err as Error).message).toBe("wispr needs a sign-in. Run `clockout connect wispr`.");
    expect((err as McpAuthError).challenge).toContain("resource_metadata=");
  });

  it("asks for a fresh token once after a 401, then gives up", async () => {
    const asked: boolean[] = [];
    const c = mcpClient({
      url: mock.url,
      name: "wispr",
      token: async (force) => {
        asked.push(force ?? false);
        return "not-a-token";
      },
    });
    await expect(c.initialize()).rejects.toThrow(
      "wispr turned down the sign-in. Run `clockout connect wispr` again.",
    );
    expect(asked).toEqual([false, true]);
  });
});
