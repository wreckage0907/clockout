import { z } from "zod";
import { loadMcpCredentials } from "../../config/credentials";
import type { McpServer } from "../../config/schema";
import { cleanText } from "../../core/text";
import type { Activity } from "../../core/types";
import { clientFor, type McpClient, type McpTool } from "../../mcp";
import type { Detected, Source } from "../types";

// Meetings you recorded ([ADR 0010](../../../docs/adr/0010-mcp-as-source-and-destination.md)).
// The server is read-only and speaks MCP, so this source is only a translation: it finds the
// tool that lists meetings, calls it for the day, and turns each recording into an Activity.
// A recording is proof you were there and how long it ran; what it says (a summary, "action
// items") is private, shown on screen and never sent to the AI or an export.

export interface WisprFlowConfig {
  type: "wispr-flow";
  server: string;
  tools?: { list?: string; meeting?: string };
}

export interface WisprFlowDeps {
  /** Overrides how a `[[mcp]]` server is reached (tests use the mock server, unsigned). */
  client?: (server: McpServer) => Promise<McpClient>;
}

/** Where `clockout connect wispr` finds the server, so nobody has to paste it. */
export const WISPR_URL = "https://api.wisprflow.ai/connect/mcp";

/** The server's name in `[[mcp]]` when the config doesn't say otherwise. */
export const WISPR_SERVER = "wispr";

export function createWisprFlowSource(deps: WisprFlowDeps = {}): Source<WisprFlowConfig> {
  const connect = deps.client ?? ((server: McpServer) => clientFor(server));
  return {
    id: "wispr-flow",
    name: "Wispr Flow",
    // Offline: the source is only connected once there's a sign-in saved for its server.
    detect: async (): Promise<Detected | null> => {
      const creds = await loadMcpCredentials(WISPR_SERVER).catch(() => null);
      return creds ? { summary: "connected" } : null;
    },
    async *collect(range, cfg, ctx) {
      const server = ctx.config.mcp.find((s) => s.name === (cfg.server || WISPR_SERVER));
      if (!server)
        throw new Error(
          `Wispr Flow: there's no MCP server called "${cfg.server}" in your config. Run \`clockout connect ${cfg.server}\`.`,
        );
      const client = await connect(server);
      const tools = await client.listTools();
      const list = listTool(tools, cfg.tools?.list);
      if (!list) throw noListTool(cfg.server, tools);
      const answer = await client.callTool(list.name, rangeArguments(list, range));
      const rows = meetingRows(answer);
      if (rows === null)
        throw new Error(
          `Wispr Flow: "${list.name}" on ${cfg.server} didn't answer with a list of meetings.`,
        );
      for (const row of rows) {
        const a = toActivity(row, ctx.config.me.emails);
        if (a && a.start >= range.from && a.start < range.to) yield a;
      }
    },
  };
}

export const wisprFlow = createWisprFlowSource();

/** A recording as an activity: attended by definition, with the calendar event it belongs to. */
export function toActivity(row: unknown, selfEmails: readonly string[] = []): Activity | null {
  const parsed = meetingRow.safeParse(row);
  if (!parsed.success) return null;
  const r = parsed.data;
  const start = dateOf(pick(r, START));
  const end = dateOf(pick(r, END));
  if (!start || !end || end <= start) return null;
  const title = cleanText(textOf(pick(r, TITLE)) ?? "") || "Recorded meeting";
  const id = textOf(pick(r, ID));
  const calendar = textOf(pick(r, CALENDAR_EVENT));
  const mine = new Set(selfEmails.map((e) => e.trim().toLowerCase()));
  const attendees = attendeesOf(pick(r, ATTENDEES)).filter((e) => !mine.has(e));
  const summary = cleanText(textOf(pick(r, SUMMARY)) ?? "");
  const refs = [...(calendar ? [`event:${calendar}`] : []), ...(id ? [`recording:${id}`] : [])];
  const a: Activity = {
    source: "wispr-flow",
    kind: "meeting",
    actor: "human",
    start,
    end,
    title,
    // A recording is evidence you were in it, for as long as it ran.
    attendance: "accepted",
    recorded: true,
    ...(refs.length ? { refs } : {}),
    ...(attendees.length ? { attendees } : {}),
    ...(summary ? { notes: summary.slice(0, 2000) } : {}),
  };
  return a;
}

/**
 * The tool that lists meetings, from the server's own list: named in config when it's given,
 * otherwise the best match for "list meetings over a range". Only a name, never an assumption.
 */
export function listTool(tools: readonly McpTool[], wanted?: string): McpTool | undefined {
  if (wanted)
    return (
      tools.find((t) => t.name === wanted) ??
      tools.find((t) => t.name.toLowerCase() === wanted.toLowerCase())
    );
  // Nothing is called on a guess unless its name starts with a read verb: a list of write verbs
  // can't be complete (start_, share_, schedule_, cancel_, invite, upload…).
  const scored = tools
    .filter((t) => READ_TOOL.test(t.name))
    .filter((t) => !WRITE_TOOL.test(t.name))
    .filter((t) => /meeting|recording/i.test(`${t.name} ${t.description ?? ""}`))
    .map((t) => ({ t, score: score(t) }))
    .sort((a, b) => b.score - a.score || a.t.name.localeCompare(b.t.name));
  return scored[0]?.t;
}

function score(tool: McpTool): number {
  let n = 0;
  const name = tool.name.toLowerCase();
  const said = (tool.description ?? "").toLowerCase();
  if (name.startsWith("list")) n += 4;
  if (/:?meetings?\b|recordings?\b/.test(name)) n += 2;
  const props = propertiesOf(tool) ?? [];
  if (FROM_KEYS.some((k) => props.includes(k)) || TO_KEYS.some((k) => props.includes(k))) n += 2;
  if (/list|between|range|during/.test(said)) n += 1;
  if (/get|read|show/.test(name)) n -= 1;
  return n;
}

function noListTool(server: string, tools: readonly McpTool[]): Error {
  const names = tools.map((t) => t.name).join(", ") || "none";
  return new Error(
    `Wispr Flow: none of ${server}'s tools lists meetings (its tools: ${names}). Set tools.list in its [[sources]] entry in config.toml.`,
  );
}

export function rangeArguments(
  tool: McpTool,
  range: { from: Date; to: Date },
): Record<string, string> {
  const props = propertiesOf(tool);
  const args: Record<string, string> = {};
  const from = props ? FROM_KEYS.find((k) => props.includes(k)) : "from";
  const to = props ? TO_KEYS.find((k) => props.includes(k)) : "to";
  if (from) args[from] = range.from.toISOString();
  if (to) args[to] = range.to.toISOString();
  return args;
}

/** The meetings in a tool's answer: an array, or the array inside its object. */
export function meetingRows(answer: unknown): unknown[] | null {
  if (Array.isArray(answer)) return answer;
  if (!answer || typeof answer !== "object") return null;
  const obj = answer as Record<string, unknown>;
  for (const key of ROW_KEYS) {
    const v = obj[key];
    if (Array.isArray(v)) return v;
  }
  const first = Object.values(obj).find(Array.isArray);
  return first ?? null;
}

// ── The server's words ───────────────────────────────────────────────────────

const READ_TOOL = /^(list|get|search|find|read)_/i;

const WRITE_TOOL =
  /(create|add|write|save|update|edit|delete|remove|send|post|append|confirm|archive)/i;

const ROW_KEYS = ["meetings", "recordings", "items", "results", "data", "events", "list"] as const;

const FROM_KEYS = ["from", "start", "start_time", "startTime", "since", "after"] as const;
const TO_KEYS = ["to", "end", "end_time", "endTime", "until", "before"] as const;

const ID = ["id", "uuid", "meeting_id", "recording_id"] as const;
const TITLE = ["title", "name", "topic", "subject"] as const;
const START = ["start", "start_time", "startTime", "started_at", "startedAt", "starts_at"] as const;
const END = ["end", "end_time", "endTime", "ended_at", "endedAt", "ends_at"] as const;
const ATTENDEES = ["attendees", "participants", "guests", "people"] as const;
const CALENDAR_EVENT = ["calendar_event_id", "calendar_event", "event_id"] as const;
const SUMMARY = ["summary", "ai_summary", "notes", "overview", "description"] as const;

const meetingRow = z.looseObject({});

const attendee = z.union([
  z.string(),
  z.looseObject({ email: z.string().optional(), name: z.string().optional() }),
]);

function pick(row: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

function textOf(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return undefined;
}

/** ISO strings, and epoch milliseconds or seconds. */
function dateOf(v: unknown): Date | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    const ms = v < 1e11 ? v * 1000 : v;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Other people in the recording, as emails: "Dev <dev@example.com>" and "dev@example.com"
 * both are one; a bare name isn't an email, so it's left out. */
function attendeesOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v : [];
  const out: string[] = [];
  for (const item of list) {
    const parsed = attendee.safeParse(item);
    if (!parsed.success) continue;
    const value = parsed.data;
    const said = typeof value === "string" ? value : (value.email ?? "");
    const angled = /<([^<>\s]+@[^<>\s]+)>/.exec(said)?.[1];
    const email = (angled ?? said).trim().toLowerCase();
    if (/^[^@\s]+@[^@\s]+$/.test(email)) out.push(email);
  }
  return [...new Set(out)];
}

function propertiesOf(tool: McpTool): string[] | null {
  const schema = tool.inputSchema;
  if (!schema) return null;
  const props = schema.properties;
  if (!props || typeof props !== "object") return null;
  return Object.keys(props as Record<string, unknown>);
}
