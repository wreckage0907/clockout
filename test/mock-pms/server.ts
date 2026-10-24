import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

// A small project-management system speaking Clockout's timesheet API (docs/timesheet-api.md),
// kept in memory. It has the rules a real one would: tasks must exist, hours are between 0 and
// 24 and a day can't pass 24, approved entries and closed weeks can't change, and a bearer token
// is required. The end-to-end tests run Clockout against it, and you can run it by hand:
//
//   pnpm mock-pms [--port 4100] [--token mock-token]
//
// Only node: imports, so Node runs this file as it is (type stripping).

export interface MockTask {
  id: string;
  subject: string;
  project: string;
}

export interface MockEntry {
  id: string;
  date: string;
  task: string;
  hours: number;
  description: string;
  /** Why it can't change, e.g. "Approved by your manager". */
  locked?: string;
}

export interface MockRequest {
  method: string;
  path: string;
  auth: string | undefined;
  body: unknown;
}

export interface MockPmsOptions {
  port?: number;
  token?: string;
  /** Path the API lives under. */
  base?: string;
  tasks?: MockTask[];
}

export const DEFAULT_TASKS: MockTask[] = [
  { id: "TASK-API", subject: "API maintenance", project: "Acme API" },
  { id: "TASK-TOOLS", subject: "Developer tooling", project: "Internal" },
  { id: "TASK-MEET", subject: "Meetings", project: "Internal" },
];

type Reply = { status: number; json?: unknown };

export async function startMockPms(opts: MockPmsOptions = {}) {
  const token = opts.token ?? "mock-token";
  const base = opts.base ?? "/api";
  const tasks = opts.tasks ?? DEFAULT_TASKS;
  const entries: MockEntry[] = [];
  const requests: MockRequest[] = [];
  const closed = new Map<string, string>();
  let down = false;
  let next = 1;

  const refuse = (status: number, error: string): Reply => ({ status, json: { error } });
  const dayTotal = (date: string, except?: string) =>
    entries.filter((e) => e.date === date && e.id !== except).reduce((s, e) => s + e.hours, 0);

  /** The problem with an entry as written, or null. */
  const invalid = (b: Record<string, unknown>, except?: string): Reply | null => {
    if (typeof b.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.date))
      return refuse(422, "date must be YYYY-MM-DD");
    if (!tasks.some((t) => t.id === b.task))
      return refuse(422, `There's no task ${String(b.task)}.`);
    if (typeof b.hours !== "number" || !(b.hours > 0) || b.hours > 24)
      return refuse(422, "Hours must be more than 0 and at most 24.");
    if (typeof b.description !== "string") return refuse(422, "description must be text");
    const why = closed.get(b.date);
    if (why) return refuse(409, why);
    if (dayTotal(b.date, except) + b.hours > 24)
      return refuse(422, `That would put more than 24 hours on ${b.date}.`);
    return null;
  };

  function route(method: string, path: string, query: URLSearchParams, body: unknown): Reply {
    if (!path.startsWith(base)) return refuse(404, "Not found");
    const p = path.slice(base.length) || "/";
    const b = (body ?? {}) as Record<string, unknown>;
    if (method === "GET" && p === "/tasks") {
      const q = (query.get("search") ?? "").toLowerCase();
      const hit = (t: MockTask) =>
        [t.id, t.subject, t.project].some((s) => s.toLowerCase().includes(q));
      return { status: 200, json: { tasks: tasks.filter(hit) } };
    }
    if (method === "GET" && p === "/entries") {
      const date = query.get("date") ?? "";
      const day = entries.filter((e) => e.date === date);
      return {
        status: 200,
        json: {
          entries: day.map(({ date: _, ...e }) => e),
          ...(closed.has(date) ? { closed: closed.get(date) } : {}),
        },
      };
    }
    if (method === "POST" && p === "/entries") {
      const bad = invalid(b);
      if (bad) return bad;
      const e: MockEntry = {
        id: `E${next++}`,
        date: b.date as string,
        task: b.task as string,
        hours: b.hours as number,
        description: b.description as string,
      };
      entries.push(e);
      return { status: 201, json: { id: e.id } };
    }
    const one = /^\/entries\/([^/]+)$/.exec(p);
    if (one) {
      const e = entries.find((x) => x.id === decodeURIComponent(one[1] ?? ""));
      if (!e) return refuse(404, "There's no such entry.");
      if (e.locked) return refuse(409, e.locked);
      if (method === "PUT") {
        const bad = invalid(b, e.id);
        if (bad) return bad;
        Object.assign(e, {
          date: b.date,
          task: b.task,
          hours: b.hours,
          description: b.description,
        });
        return { status: 200, json: { id: e.id } };
      }
      if (method === "DELETE") {
        const why = closed.get(e.date);
        if (why) return refuse(409, why);
        entries.splice(entries.indexOf(e), 1);
        return { status: 204 };
      }
    }
    return refuse(404, "Not found");
  }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (d) => {
      raw += d;
    });
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body: unknown;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = undefined;
      }
      const auth = req.headers.authorization;
      requests.push({ method: req.method ?? "GET", path: url.pathname, auth, body });
      const reply: Reply = down
        ? refuse(503, "Down for maintenance")
        : auth !== `Bearer ${token}`
          ? refuse(401, "Invalid token")
          : raw && body === undefined
            ? refuse(400, "Body isn't JSON")
            : route(req.method ?? "GET", url.pathname, url.searchParams, body);
      res.writeHead(
        reply.status,
        reply.json === undefined ? {} : { "content-type": "application/json" },
      );
      res.end(reply.json === undefined ? undefined : JSON.stringify(reply.json));
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}${base}`;

  return {
    url,
    token,
    tasks,
    entries,
    requests,
    /** Entries on a date, without their date. */
    day: (date: string) => entries.filter((e) => e.date === date),
    /** Approves an entry: it can't be changed or deleted any more. */
    lock(id: string, why = "Approved by your manager.") {
      const e = entries.find((x) => x.id === id);
      if (e) e.locked = why;
    },
    /** Closes a date, as an approved week would. */
    closeDate(date: string, why = "This week is already approved.") {
      closed.set(date, why);
    },
    /** Answers every request with 503 while true. */
    setDown(value: boolean) {
      down = value;
    },
    writes: () => requests.filter((r) => r.method !== "GET"),
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type MockPms = Awaited<ReturnType<typeof startMockPms>>;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const arg = (name: string) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  const pms = await startMockPms({ port: Number(arg("port") ?? 4100), token: arg("token") });
  console.log(`Mock PMS on ${pms.url} (Ctrl+C stops it; entries are kept in memory)

In ~/.config/clockout/config.toml:

[timesheet]
type = "http"
url = "${pms.url}"

Then: CLOCKOUT_TIMESHEET_TOKEN=${pms.token} clockout
Tasks: ${pms.tasks.map((t) => `${t.id} (${t.subject})`).join(", ")}`);
}
