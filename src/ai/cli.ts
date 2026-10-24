import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { execa } from "execa";
import { z } from "zod";

/** Every AI call runs in a fresh folder with this prefix; sources skip sessions started in one. */
export const TEMP_PREFIX = "clockout-ai-";

/** What a CLI printed. Throws only when it couldn't be started or timed out. */
export interface Ran {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs an agent CLI; tests replace it. */
export type Runner = (
  cmd: string,
  args: string[],
  opts: { input: string; cwd: string; env?: Record<string, string> },
) => Promise<Ran>;

export const runCli: Runner = async (cmd, args, { input, cwd, env }) => {
  const r = await execa(cmd, args, {
    input,
    cwd,
    timeout: 120_000,
    reject: false,
    ...(env ? { env } : {}),
  });
  if (r.timedOut) throw new Error("didn't answer within 2 minutes");
  if (r.failed && r.exitCode === undefined)
    throw new Error(r.code === "ENOENT" ? "isn't installed" : "couldn't be started");
  return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode ?? 1 };
};

/** First word of `<cmd> --version`, or null when it isn't on PATH. */
export async function cliVersion(
  cmd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const { stdout } = await execa(cmd, ["--version"], { env, timeout: 10_000 });
    return stdout.trim().match(/\d+\.\d+[\w.-]*/)?.[0] ?? (stdout.trim().split(/\s+/)[0] || null);
  } catch {
    return null;
  }
}

/** An empty folder for one call, with an empty `work` folder inside for the agent. */
export async function inTempDir<T>(fn: (dir: string, work: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
  const work = join(dir, "work");
  try {
    await mkdir(work);
    return await fn(dir, work);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Asks twice at most: `once` returns the raw value or throws when the CLI itself failed (which
 * isn't retried); a value that doesn't fit the schema is asked for again.
 */
export async function validated<T>(
  name: string,
  schema: z.ZodType<T>,
  once: () => Promise<unknown>,
): Promise<T> {
  let problem = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await once();
    if (raw === undefined) {
      problem = "unreadable output";
      continue;
    }
    const value = schema.safeParse(withoutNulls(raw));
    if (value.success) return value.data;
    problem = "output didn't match the expected shape";
  }
  throw new Error(`${name}: ${problem}.`);
}

/** JSON Schema for a zod schema, without the "$schema" draft marker CLIs don't resolve. */
export function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

/**
 * The strict form OpenAI's structured output wants: every property required (optional ones may
 * be null instead) and anyOf for oneOf. `withoutNulls` turns the nulls back into absent keys.
 */
export function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) out[k === "oneOf" ? "anyOf" : k] = strictSchema(v);
  const props = out.properties;
  if (props && typeof props === "object" && !Array.isArray(props)) {
    const required = new Set(Array.isArray(out.required) ? out.required : []);
    const all = props as Record<string, unknown>;
    for (const [k, v] of Object.entries(all)) if (!required.has(k)) all[k] = nullable(v);
    out.required = Object.keys(all);
    out.additionalProperties = false;
  }
  return out;
}

function nullable(node: unknown): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const n = node as Record<string, unknown>;
  if (typeof n.type === "string" && !("const" in n) && !("enum" in n))
    return { ...n, type: [n.type, "null"] };
  return { anyOf: [n, { type: "null" }] };
}

/** Drops null object values, so a strict answer's "not given" reads as an absent key. */
export function withoutNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutNulls);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => [k, withoutNulls(v)]),
  );
}

export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The JSON object in a model's plain-text reply, with or without a code fence around it. */
export function jsonIn(text: string): unknown {
  const t = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t)?.[1];
  const direct = parseJson(fenced ?? t);
  if (direct !== undefined) return direct;
  const from = t.indexOf("{");
  const to = t.lastIndexOf("}");
  return from >= 0 && to > from ? parseJson(t.slice(from, to + 1)) : undefined;
}

/** For CLIs that can't enforce a schema: the instructions say what to answer with. */
export function answerWith(system: string, schema: z.ZodType): string {
  return `${system}

Answer with one JSON object and nothing else (no prose, no code fence). It must match this JSON Schema:
${JSON.stringify(jsonSchema(schema))}`;
}

/** The useful last line a CLI wrote about a failure, without ANSI colours. */
export function lastLine(text: string): string {
  const lines = stripVTControlCharacters(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.at(-1) ?? "";
}

/**
 * A CLI's own words about a failure, shortened, plus how to sign in again when that's the
 * problem ("Not logged in", "401", "invalid API key").
 */
export function cliFailure(name: string, said: string, signIn: string): Error {
  const short = said.length > 200 ? `${said.slice(0, 199)}…` : said;
  const auth =
    /not (?:logged|signed) in|log ?in\b|sign ?in\b|unauthori[sz]ed|\b401\b|api key|credential|access token|expired/i.test(
      said,
    );
  const hint = auth ? ` Not signed in, or the sign-in expired: ${signIn}` : "";
  return new Error(`${name}: ${short.replace(/\.$/, "")}.${hint}`);
}
