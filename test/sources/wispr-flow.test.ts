import { afterEach, describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { clientFor } from "../../src/mcp";
import {
  createWisprFlowSource,
  listTool,
  meetingRows,
  rangeArguments,
  toActivity,
} from "../../src/sources/wispr-flow";
import { type MockMcp, startMockMcp } from "../mock-mcp/server";

// The Wispr Flow source against the mock MCP server (test/mock-mcp), whose tools are a
// recorder's: it lists recorded meetings over a range and reads one in full.

const TZ = "Asia/Kolkata";
const DATE = "2026-10-16";

let mock: MockMcp | undefined;
afterEach(async () => {
  await mock?.stop();
  mock = undefined;
});

function configWith(url: string) {
  return configSchema.parse({
    me: { name: "Dev", emails: ["dev@example.com"], timezone: TZ },
    mcp: [{ name: "wispr", url }],
    sources: [{ type: "wispr-flow", server: "wispr" }],
  });
}

/** The source, reading the mock without a sign-in (a real one signs in with `connect wispr`). */
function sourceFor() {
  return createWisprFlowSource({
    client: (server) => clientFor(server, { creds: null }),
  });
}

async function collect(cfg: ReturnType<typeof configWith>, id = "wispr-flow") {
  const out: Activity[] = [];
  const source = sourceFor();
  const sourceConfig = cfg.sources.find((s) => s.type === id);
  if (!sourceConfig) throw new Error("test config has no such source");
  for await (const a of source.collect(dayRange(DATE, TZ), sourceConfig as never, {
    config: cfg,
    homeDir: "/home/dev",
    env: {},
  }))
    out.push(a);
  return out;
}

describe("wispr-flow source", () => {
  it("turns each recording into a meeting you attended, with its calendar event", async () => {
    mock = await startMockMcp({ open: true });
    const activities = await collect(configWith(mock.url));
    expect(activities).toHaveLength(2);
    expect(activities[0]).toEqual({
      source: "wispr-flow",
      kind: "meeting",
      actor: "human",
      start: new Date("2026-10-16T04:30:00Z"),
      end: new Date("2026-10-16T04:47:00Z"),
      title: "Daily standup",
      attendance: "accepted",
      recorded: true,
      refs: ["event:standup-1", "recording:rec-1"],
      // You're left out of the attendees: your own domain decides nothing about the project.
      attendees: ["lead@example.com"],
      notes: "Went through yesterday's deploy.",
    });
    // A meeting with no calendar event has no event ref.
    expect(activities[1]?.refs).toEqual(["recording:rec-2"]);
  });

  it("asks the server for the day's range, in the names its own tool uses", async () => {
    mock = await startMockMcp({ open: true });
    await collect(configWith(mock.url));
    const call = mock.calls("list_meetings")[0];
    expect(JSON.parse(call?.body ?? "").params).toEqual({
      name: "list_meetings",
      arguments: { from: "2026-10-15T18:30:00.000Z", to: "2026-10-16T18:30:00.000Z" },
    });
  });

  it("lists the tools it will use rather than assuming them", async () => {
    mock = await startMockMcp({ open: true });
    const before = mock.requests.length;
    await collect(configWith(mock.url));
    const sent = mock.requests.slice(before).map((r) => r.method);
    expect(sent).toContain("tools/list");
    expect(sent.indexOf("tools/list")).toBeLessThan(sent.indexOf("tools/call"));
  });

  it("says which tools there are when the server has no meeting list", async () => {
    mock = await startMockMcp({ open: true });
    const cfg = configSchema.parse({
      ...configWith(mock.url),
      sources: [{ type: "wispr-flow", server: "wispr", tools: { list: "list_notes" } }],
    });
    await expect(collect(cfg)).rejects.toThrow(
      "Wispr Flow: none of wispr's tools lists meetings (its tools: list_meetings, get_meeting, write_note, always_fails). Set tools.list in its [[sources]] entry in config.toml.",
    );
  });

  it("shows the system's own error when the tool fails", async () => {
    mock = await startMockMcp({ open: true });
    const cfg = configSchema.parse({
      ...configWith(mock.url),
      sources: [{ type: "wispr-flow", server: "wispr", tools: { list: "always_fails" } }],
    });
    await expect(collect(cfg)).rejects.toThrow("wispr: The notes service is down for maintenance.");
  });

  it("says how to add the server when the config names one that isn't there", async () => {
    const cfg = configSchema.parse({
      me: { name: "Dev", emails: ["dev@example.com"], timezone: TZ },
      sources: [{ type: "wispr-flow", server: "wispr" }],
    });
    await expect(collect(cfg)).rejects.toThrow(
      'Wispr Flow: there\'s no MCP server called "wispr" in your config. Run `clockout connect wispr`.',
    );
  });

  it("keeps no recording that starts outside the day", async () => {
    mock = await startMockMcp({
      open: true,
      meetings: [
        {
          id: "old",
          title: "Yesterday's review",
          start: "2026-10-14T09:00:00Z",
          end: "2026-10-14T09:30:00Z",
          attendees: [],
          summary: "",
        },
      ],
    });
    expect(await collect(configWith(mock.url))).toEqual([]);
  });
});

describe("reading a recorder's answer", () => {
  it("finds the meetings in whatever the object is called", () => {
    expect(meetingRows({ meetings: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(meetingRows({ recordings: [{ a: 1 }] })).toEqual([{ a: 1 }]);
    expect(meetingRows({ data: { items: [{ a: 1 }] } })).toBeNull();
    expect(meetingRows([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(meetingRows("no")).toBeNull();
  });

  it("reads a recording's times from ISO strings or epochs, and needs both", () => {
    const base = {
      title: "Design review",
      attendees: ["lead@example.com", "Just A Name"],
    };
    expect(
      toActivity({ ...base, start: "2026-10-16T09:00:00Z", end: "2026-10-16T09:30:00Z" }),
    ).toMatchObject({
      start: new Date("2026-10-16T09:00:00Z"),
      attendees: ["lead@example.com"],
    });
    expect(
      toActivity({ ...base, start: 1760605200000, end: 1760607000000 })?.start.toISOString(),
    ).toBe(new Date(1760605200000).toISOString());
    expect(toActivity({ ...base, start: "2026-10-16T09:00:00Z" })).toBeNull();
    expect(
      toActivity({ ...base, start: "2026-10-16T09:30:00Z", end: "2026-10-16T09:00:00Z" }),
    ).toBeNull();
  });

  it("keeps a recording with no title but doesn't keep control characters", () => {
    expect(
      toActivity({
        start: "2026-10-16T09:00:00Z",
        end: "2026-10-16T09:30:00Z",
        title: "\u001b[2J",
      }),
    ).toMatchObject({ title: "Recorded meeting" });
  });
});

describe("choosing the list tool", () => {
  const tool = (name: string, description?: string, properties?: Record<string, unknown>) => ({
    name,
    ...(description ? { description } : {}),
    ...(properties ? { inputSchema: { type: "object", properties } } : {}),
  });

  it("prefers a list tool over a read-one tool and skips writes", () => {
    const tools = [
      tool("get_meeting", "One recorded meeting", { id: { type: "string" } }),
      tool("create_meeting", "Start a recording"),
      tool("list_recordings", "Recordings between two times", {
        from: { type: "string" },
        to: { type: "string" },
      }),
    ];
    expect(listTool(tools)?.name).toBe("list_recordings");
  });

  it("takes the name from config when it's given, in any case", () => {
    const tools = [tool("list_meetings"), tool("find_notes")];
    expect(listTool(tools, "find_notes")?.name).toBe("find_notes");
    expect(listTool(tools, "FIND_NOTES")?.name).toBe("find_notes");
    expect(listTool(tools, "nothing")).toBeUndefined();
  });

  it("finds nothing when the server only writes", () => {
    expect(listTool([tool("write_note", "Adds a note")])).toBeUndefined();
  });
});

describe("arguments for a range", () => {
  const range = { from: new Date("2026-10-16T00:00:00Z"), to: new Date("2026-10-17T00:00:00Z") };
  const props = (p: Record<string, unknown>) => ({
    name: "list_meetings",
    inputSchema: { type: "object", properties: p },
  });

  it("uses the server's own names", () => {
    expect(rangeArguments(props({ start_time: {}, end_time: {} }), range)).toEqual({
      start_time: "2026-10-16T00:00:00.000Z",
      end_time: "2026-10-17T00:00:00.000Z",
    });
  });

  it("sends from and to when the tool doesn't say what it wants", () => {
    expect(rangeArguments({ name: "list_meetings" }, range)).toEqual({
      from: "2026-10-16T00:00:00.000Z",
      to: "2026-10-17T00:00:00.000Z",
    });
  });

  it("sends nothing the tool has no place for", () => {
    expect(rangeArguments(props({ limit: {} }), range)).toEqual({});
  });
});

describe("the people in a recording", () => {
  const at = { start: "2026-10-16T09:00:00Z", end: "2026-10-16T09:30:00Z", title: "Review" };

  it("leaves you out, so your own domain never decides the project", () => {
    const a = toActivity({ ...at, attendees: ["Dev <dev@example.com>", "lead@example.com"] }, [
      "dev@example.com",
    ]);
    expect(a?.attendees).toEqual(["lead@example.com"]);
  });

  it('takes an address out of "Name <address>" and drops bare names', () => {
    const a = toActivity({ ...at, attendees: ["Lead <lead@example.com>", "Just A Name"] });
    expect(a?.attendees).toEqual(["lead@example.com"]);
  });
});
