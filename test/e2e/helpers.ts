import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDb } from "../helpers/sqlite-fixture";

// The built CLI run as a separate process, the way people run it: its own home folder, no
// network beyond fake servers on 127.0.0.1, and a PATH with only node on it, so nothing the
// machine happens to have (the developer's agent CLIs, gh on CI runners) is ever picked up.

export const bin = new URL("../../dist/cli.js", import.meta.url).pathname;
export const fixtures = new URL("../fixtures/", import.meta.url).pathname;
export const DATE = "2026-10-16";

export interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

export interface Sandbox {
  home: string;
  config: string;
  data: string;
  env: Record<string, string>;
  run(args: string[], opts?: { env?: Record<string, string>; input?: string }): Promise<Ran>;
  writeConfig(toml: string): Promise<void>;
}

export async function sandbox(): Promise<Sandbox> {
  const home = await mkdtemp(join(tmpdir(), "clockout-e2e-"));
  const binDir = join(home, "bin");
  await mkdir(binDir);
  // Only node itself: its own folder may hold claude, codex or pi.
  await symlink(process.execPath, join(binDir, "node"));
  const config = join(home, ".config", "clockout");
  const data = join(home, ".local", "share", "clockout");
  const env: Record<string, string> = {
    PATH: binDir,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    XDG_DATA_HOME: join(home, ".local", "share"),
    TMPDIR: tmpdir(),
    TZ: "UTC",
    LANG: "C",
  };
  return {
    home,
    config,
    data,
    env,
    run: (args, opts = {}) => runCli(args, { ...env, ...opts.env }, home, opts.input),
    async writeConfig(toml) {
      await mkdir(config, { recursive: true, mode: 0o700 });
      await writeFile(join(config, "config.toml"), toml, { mode: 0o600 });
    },
  };
}

function runCli(
  args: string[],
  env: Record<string, string>,
  cwd: string,
  input = "",
): Promise<Ran> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bin, ...args], { env, cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

/**
 * A config reading every local source from the fixtures (opencode's database built from its
 * SQL script into the sandbox), the calendar from the fixture .ics, and no AI.
 */
export async function fixtureSourcesToml(sb: Sandbox, extra = ""): Promise<string> {
  const db = join(sb.home, "opencode.db");
  await buildDb(join(fixtures, "opencode/opencode.sql"), db);
  return `[me]
name = "Dev"
emails = ["dev@example.com"]
timezone = "Asia/Kolkata"

[ai]
backend = "none"

[[sources]]
type = "claude-code"
projects_dir = "${join(fixtures, "claude/projects")}"

[[sources]]
type = "codex"
sessions_dir = "${join(fixtures, "codex/sessions")}"

[[sources]]
type = "pi"
sessions_dir = "${join(fixtures, "pi/sessions")}"

[[sources]]
type = "opencode"
db = "${db}"

[[sources]]
type = "calendar"
method = "ics"
url = "file://${join(fixtures, "ics/calendar.ics")}"
${extra}`;
}

export interface Request {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: string;
}

/** An HTTP server on 127.0.0.1 answering with `handle`, recording every request. */
export async function fakeServer(
  handle: (req: Request, origin: string) => { status?: number; json: unknown },
) {
  const requests: Request[] = [];
  let origin = "";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => {
      body += d;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", origin);
      const r: Request = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
      };
      requests.push(r);
      const { status = 200, json } = handle(r, origin);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export const fixtureJson = async (path: string) =>
  JSON.parse(await readFile(join(fixtures, path), "utf8")) as unknown;
