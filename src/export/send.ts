import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { runCommand } from "../command";
import type { Config, ExportDestination, ExportFormat } from "../config/schema";
import { fileError } from "../files";
import { clientFor, type McpClient, McpToolError } from "../mcp";

// Where an export goes besides the clipboard ([ADR 0010](../../docs/adr/0010-mcp-as-source-and-destination.md)):
// a file such as an Obsidian daily note, or one tool on a connected MCP server. Planned first,
// so the text and where it's going are shown before anything is written. A path only ever comes
// from the config, never from the AI.

export interface DestinationPlan {
  /** What kind of place it is, for the wording. */
  kind: "file" | "mcp";
  /** Where it goes, as you'd say it: "~/Vault/Daily/2026-10-16.md", "notion · append_block". */
  where: string;
  /** The absolute path, for a file. */
  path?: string;
  /** The text that will be written, as it will be. */
  text: string;
  /** What `{date}` becomes. */
  date: string;
  /** A file that's there already, which is replaced unless the destination appends. */
  exists: boolean;
}

export interface PlanOptions {
  date: string;
  home?: string;
  /** Does this file exist? (Tests answer without touching the disk.) */
  exists?: (path: string) => Promise<boolean>;
}

/** The destination an export format names, if it has one. */
export function destinationOf(format: ExportFormat | undefined): ExportDestination | undefined {
  return format?.to;
}

/** One line for a proposal or a list: where the text goes, and how. */
export function describeDestination(to: ExportDestination, date: string, home = homedir()): string {
  if ("file" in to)
    return `${tildify(filePath(to.file, date, home), home)}${to.append ? " (added to the end)" : " (replaced)"}`;
  if ("command" in to) return `the program ${to.command.join(" ")}`;
  const args = Object.keys(to.arguments ?? {});
  return `${to.mcp} · ${to.tool}${args.length ? ` (${args.join(", ")})` : ""}`;
}

export async function planDestination(
  to: ExportDestination,
  text: string,
  opts: PlanOptions,
): Promise<DestinationPlan> {
  const home = opts.home ?? homedir();
  const where = describeDestination(to, opts.date, home);
  if ("file" in to) {
    const path = filePath(to.file, opts.date, home);
    const exists = await (opts.exists ?? fileExists)(path);
    return { kind: "file", where, path, text, date: opts.date, exists };
  }
  return { kind: "mcp", where, text, date: opts.date, exists: false };
}

/** Writes the plan out; returns what happened, in one line. */
export async function writeDestination(
  to: ExportDestination,
  plan: DestinationPlan,
  opts: { config: Config },
): Promise<string> {
  if ("file" in to && plan.path) {
    const body = to.append ? await appended(plan.path, plan.text) : ended(plan.text);
    await mkdir(dirname(plan.path), { recursive: true }).catch((err: unknown) => {
      throw fileError(plan.path ?? "", err);
    });
    await writeFile(plan.path, body, { mode: 0o600 }).catch((err: unknown) => {
      throw fileError(plan.path ?? "", err);
    });
    const lines = plan.text.split("\n").filter(Boolean).length;
    return `Wrote ${lines} line${lines === 1 ? "" : "s"} to ${plan.where}`;
  }
  if ("command" in to) {
    // A program you named: JSON on stdin, one JSON answer back (ADR 0009, layer 4).
    const { json } = await runCommand(
      to.command,
      {
        op: "text",
        date: plan.date,
        text: plan.text,
      },
      { name: "the program the export names" },
    );
    const said = typeof json.message === "string" ? `: ${json.message}` : "";
    return `Handed it to ${to.command.join(" ")}${said}`;
  }
  if (!("mcp" in to)) throw new Error("That destination isn't one Clockout can write to.");
  const mcp = to;
  const server = opts.config.mcp.find((s) => s.name === mcp.mcp);
  if (!server)
    throw new Error(
      `There's no MCP server called "${mcp.mcp}" in your config. Run \`clockout connect ${mcp.mcp} <https://…/mcp>\`.`,
    );
  const client = await clientFor(server);
  await namedTool(client, mcp);
  try {
    await client.callTool(mcp.tool, argumentsFor(mcp, plan));
  } catch (err) {
    // The server's own words, with where they came from.
    if (err instanceof McpToolError)
      throw new Error(`Couldn't write to ${plan.where}: ${err.message}`);
    throw err;
  }
  return `Called ${mcp.tool} on ${mcp.mcp}`;
}

/** The text as it goes into a file: whole lines. */
function ended(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}

/** The text after whatever the file already says, with one blank line between. */
async function appended(path: string, text: string): Promise<string> {
  const before = await readFile(path, "utf8").catch(() => "");
  if (!before) return ended(text);
  return `${before}${before.endsWith("\n") ? "" : "\n"}\n${ended(text)}`;
}

async function fileExists(path: string): Promise<boolean> {
  return await readFile(path).then(
    () => true,
    () => false,
  );
}

/** Only the tools the server says it has: a wrong name is named, with the ones there are. */
async function namedTool(
  client: McpClient,
  to: Extract<ExportDestination, { mcp: string }>,
): Promise<void> {
  const tools = await client.listTools().catch(() => []);
  if (tools.length && !tools.some((t) => t.name === to.tool))
    throw new Error(
      `${to.mcp} has no tool called "${to.tool}". It offers: ${tools.map((t) => t.name).join(", ")}.`,
    );
}

function argumentsFor(
  to: Extract<ExportDestination, { mcp: string }>,
  plan: DestinationPlan,
): Record<string, string> {
  const fields: Record<string, string> = { text: plan.text, date: plan.date };
  return Object.fromEntries(
    Object.entries(to.arguments ?? { text: "{text}" }).map(([k, v]) => [
      k,
      v.replace(/\{(text|date)\}/g, (_, f: string) => fields[f] ?? ""),
    ]),
  );
}

/** The path, with `~` and `{date}` filled in; the only fields a destination may use. */
export function filePath(template: string, date: string, home = homedir()): string {
  const filled = template.replace(/\{date\}/g, date);
  if (filled === "~") return home;
  if (filled.startsWith("~/")) return join(home, filled.slice(2));
  return filled;
}

function tildify(path: string, home = homedir()): string {
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
