import { rmSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { execa } from "execa";
import { z } from "zod";
import { redactSecrets } from "../core/secrets";

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

/**
 * What an agent CLI may inherit from Clockout's environment: an allowlist, not a blocklist, so a
 * secret Clockout holds (or one added to the shell tomorrow) never reaches a model that has just
 * read text from a calendar or a PR title. Only what the CLI needs to start, find its own
 * login and reach its provider.
 */
const PASS_EXACT = new Set([
  // Finding programs, the user's home and the terminal.
  ...[
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "TERM",
    "COLORTERM",
    "NO_COLOR",
    "LANG",
    "LANGUAGE",
  ],
  ...["TMPDIR", "TMP", "TEMP", "TZ"],
  // Windows equivalents of the above.
  ...["SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "USERPROFILE", "USERNAME", "APPDATA"],
  ...["LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "HOMEDRIVE", "HOMEPATH"],
  // Networks behind a proxy or a private certificate authority.
  ...["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"],
  ...[
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
  ],
  // Version managers whose shims start the CLI.
  ...["NVM_DIR", "VOLTA_HOME", "PNPM_HOME", "ASDF_DIR", "ASDF_DATA_DIR", "MISE_DATA_DIR"],
  // The CLIs' own config folders and providers without a common prefix (Pi's list, `pi --help`).
  ...["CLAUDE_CONFIG_DIR", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_GATEWAY_ID", "AI_GATEWAY_API_KEY"],
]);
const PASS_PREFIX = [
  "LC_",
  "XDG_",
  // Claude Code, opencode and Pi's own settings, and the providers they sign in to.
  ...["CLAUDE_", "ANTHROPIC_", "OPENCODE_", "PI_", "OPENAI_", "OPENROUTER_", "AZURE_", "AWS_"],
  ...["GOOGLE_", "GEMINI_", "VERTEX_", "GROQ_", "MISTRAL_", "DEEPSEEK_", "XAI_", "TOGETHER_"],
  ...["FIREWORKS_", "CEREBRAS_", "OLLAMA_", "MOONSHOT_", "ZAI_", "MINIMAX_", "NVIDIA_"],
];
/** Any other provider's key or endpoint, e.g. FOO_API_KEY, as Pi and opencode read them. */
const PASS_PATTERN = /^[A-Z0-9]+(?:_[A-Z0-9]+)*_(?:API_KEY|BASE_URL|API_BASE)$/;

/** Held by Clockout itself, so never passed on, even where a pattern above would match. */
const WITHHELD_EXACT = new Set([
  ...["GITHUB_TOKEN", "GH_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN"],
]);
const WITHHELD_PREFIX = ["CLOCKOUT_"];

/**
 * The environment for an agent CLI: `base` (Clockout's own) cut down to what the CLI needs.
 * `withheld` names more variables to hold back, like the one the timesheet token is read from.
 */
export function agentEnv(
  base: NodeJS.ProcessEnv = process.env,
  withheld: readonly string[] = [],
): Record<string, string> {
  const held = new Set([...WITHHELD_EXACT, ...withheld.map((n) => n.toUpperCase())]);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    const name = key.toUpperCase(); // Windows spells it Path
    if (held.has(name) || WITHHELD_PREFIX.some((p) => name.startsWith(p))) continue;
    if (
      PASS_EXACT.has(name) ||
      PASS_PREFIX.some((p) => name.startsWith(p)) ||
      PASS_PATTERN.test(name)
    )
      out[key] = value;
  }
  return out;
}

/**
 * Runs an agent CLI in its own process group, so that on a timeout, or when Clockout quits
 * (Ctrl+C, a closed terminal), the whole group goes: agent CLIs start processes of their own,
 * which would otherwise keep running and keep the output open. It gets `agentEnv`, plus
 * `opts.env`; `withheld` names further variables of Clockout's that must not reach it.
 */
export function cliRunner(timeoutMs: number, withheld: readonly string[] = []): Runner {
  return async (cmd, args, { input, cwd, env }) => {
    const sub = execa(cmd, args, {
      input,
      cwd,
      reject: false,
      detached: true,
      cleanup: false,
      extendEnv: false,
      env: { ...agentEnv(process.env, withheld), ...env },
    });
    const pid = sub.pid;
    if (pid) helpers.add(pid);
    watchExit();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid) killGroup(pid);
    }, timeoutMs);
    try {
      const r = await sub;
      if (timedOut) throw new Error(`didn't answer within ${minutes(timeoutMs)}`);
      if (r.failed && r.exitCode === undefined)
        throw new Error(r.code === "ENOENT" ? "isn't installed" : "couldn't be started");
      return { stdout: String(r.stdout), stderr: String(r.stderr), exitCode: r.exitCode ?? 1 };
    } finally {
      clearTimeout(timer);
      if (pid) helpers.delete(pid);
    }
  };
}

export const runCli: Runner = cliRunner(120_000);

function minutes(ms: number): string {
  const [n, unit] =
    ms >= 60_000 ? [Math.round(ms / 60_000), "minute"] : [Math.ceil(ms / 1000), "second"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** Process groups of helpers still running, and temp folders still in use. */
const helpers = new Set<number>();
const folders = new Set<string>();

/** Kills a process group started with `detached: true` (its leader's pid is the group's id). */
export function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

/**
 * Registers a detached helper's process group so it's killed when Clockout quits (Ctrl+C, a
 * closed terminal); the returned function takes it off the list once it has finished.
 */
export function trackHelper(pid: number): () => void {
  helpers.add(pid);
  watchExit();
  return () => void helpers.delete(pid);
}

/** Stops every helper still running and removes their folders; for when Clockout quits. */
export function stopHelpers(): void {
  for (const pid of helpers) killGroup(pid);
  helpers.clear();
  for (const dir of folders) rmSync(dir, { recursive: true, force: true });
  folders.clear();
}

let watching = false;
function watchExit(): void {
  if (watching) return;
  watching = true;
  process.once("exit", stopHelpers);
  // A signal skips "exit" handlers unless something handles it; quit the usual way after cleaning up.
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ] as const)
    process.once(signal, () => {
      stopHelpers();
      process.exit(code);
    });
}

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
  folders.add(dir);
  try {
    await mkdir(work);
    return await fn(dir, work);
  } finally {
    folders.delete(dir);
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
  let cause: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await once();
    if (raw === undefined) {
      problem = "unreadable output";
      cause = new Error("no JSON object in the answer");
      continue;
    }
    const value = schema.safeParse(withoutNulls(raw));
    if (value.success) return value.data;
    problem = "output didn't match the expected shape";
    cause = value.error;
  }
  throw new Error(`${name}: ${problem}.`, { cause });
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
export function cliFailure(name: string, raw: string, signIn: string): Error {
  // On screen too, and maybe in a demo or a pasted bug report: no tokens it may have echoed.
  const said = redactSecrets(raw);
  const short = said.length > 200 ? `${said.slice(0, 199)}…` : said;
  const auth =
    /not (?:logged|signed) in|log ?in\b|sign ?in\b|unauthori[sz]ed|\b401\b|api key|credential|access token|expired/i.test(
      said,
    );
  const hint = auth ? ` Not signed in, or the sign-in expired: ${signIn}` : "";
  return new Error(`${name}: ${short.replace(/\.$/, "")}.${hint}`);
}
