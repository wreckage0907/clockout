import { execFile } from "node:child_process";
import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// examples/next-pms.mjs: a `command` target for next-pms, run as Clockout runs it (one JSON
// request on stdin, one answer on stdout) against a fake Frappe site on 127.0.0.1.

const SCRIPT = join(import.meta.dirname, "../../examples/next-pms.mjs");
const API = "/api/method/next_pms.timesheet.api";

interface Call {
  path: string;
  auth: string | undefined;
  body: unknown;
}

let server: Server;
let origin = "";
let settings = "";
const calls: Call[] = [];

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    calls.push({ path: url.pathname, auth: req.headers.authorization, body: await bodyOf(req) });
    const send = (status: number, json: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.headers.authorization !== "token k1:s1") return send(401, {});
    switch (url.pathname) {
      case `${API}.employee.get_data`:
        return send(200, { message: { employee: "EMP-1" } });
      case `${API}.timesheet.get_timesheet_data`:
        return send(200, {
          message: {
            data: {
              w44: {
                dates: ["2026-10-26", "2026-10-27"],
                status: "Not Submitted",
                tasks: {
                  "TASK-1": {
                    data: [
                      {
                        name: "TD-1",
                        parent: "TS-9",
                        task: "TASK-1",
                        hours: 1.5,
                        description: "<p>Reviewed\u001b[2J the API</p>",
                        from_time: "2026-10-27 09:00:00",
                      },
                      {
                        name: "TD-2",
                        parent: "TS-9",
                        task: "TASK-1",
                        hours: 2,
                        description: "Other day",
                        from_time: "2026-10-26 09:00:00",
                      },
                      {
                        name: "TD-3",
                        parent: "TS-9",
                        task: "TASK-1",
                        hours: 1,
                        description: "Approved",
                        from_time: "2026-10-27 11:00:00",
                        docstatus: 1,
                      },
                    ],
                  },
                },
              },
            },
          },
        });
      case `${API}.task.get_task_list`:
        return send(200, {
          message: { task: [{ name: "TASK-1", subject: "API work", project_name: "Acme" }] },
        });
      case `${API}.timesheet.save`:
        return (calls.at(-1)?.body as { hours?: number } | undefined)?.hours === 99
          ? send(417, {
              _server_messages: JSON.stringify([JSON.stringify({ message: "Too many hours" })]),
            })
          : send(200, { message: null });
      case `${API}.timesheet.update_timesheet_detail`:
      case `${API}.timesheet.delete`:
        return send(200, { message: null });
      default:
        return send(404, {
          exception: "frappe.exceptions.DoesNotExistError: Failed to get method",
        });
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = await mkdtemp(join(tmpdir(), "clockout-next-pms-"));
  settings = join(dir, "next-pms.json");
  await writeFile(settings, JSON.stringify({ url: origin, api_key: "k1", api_secret: "s1" }), {
    mode: 0o600,
  });
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function run(
  request: unknown,
  file = settings,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT],
      { env: { PATH: process.env.PATH ?? "", NEXT_PMS_SETTINGS: file } },
      (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
    );
    child.stdin?.end(JSON.stringify(request));
  });
}

describe("the next-pms command target", () => {
  it("lists the day's entries, with the timesheet in each id and approved ones locked", async () => {
    const r = await run({ op: "day", date: "2026-10-27" });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({
      entries: [
        { id: "TS-9::TD-1", task: "TASK-1", hours: 1.5, description: "Reviewed the API" },
        {
          id: "TS-9::TD-3",
          task: "TASK-1",
          hours: 1,
          description: "Approved",
          locked: "Already approved in the ERP.",
        },
      ],
    });
    expect(calls.at(-1)?.auth).toBe("token k1:s1");
  });

  it("searches tasks", async () => {
    const r = await run({ op: "tasks", search: "api" });
    expect(JSON.parse(r.stdout)).toEqual({
      tasks: [{ id: "TASK-1", subject: "API work", project: "Acme" }],
    });
  });

  it("creates, updates and deletes through next-pms's own methods", async () => {
    const entry = { task: "TASK-1", hours: 1.25, description: "Fixed the export" };
    expect(JSON.parse((await run({ op: "create", date: "2026-10-27", entry })).stdout)).toEqual({});
    expect(calls.at(-1)).toMatchObject({
      path: `${API}.timesheet.save`,
      body: { date: "2026-10-27", ...entry },
    });
    await run({ op: "update", date: "2026-10-27", id: "TS-9::TD-1", parent: "", entry });
    expect(calls.at(-1)).toMatchObject({
      path: `${API}.timesheet.update_timesheet_detail`,
      body: { name: "TD-1", parent: "TS-9", date: "2026-10-27", ...entry },
    });
    await run({ op: "delete", id: "TS-9::TD-1", parent: "" });
    expect(calls.at(-1)).toMatchObject({
      path: `${API}.timesheet.delete`,
      body: { parent: "TS-9", name: "TD-1" },
    });
  });

  it("answers a refused write with next-pms's own message", async () => {
    const r = await run({
      op: "create",
      date: "2026-10-27",
      entry: { task: "TASK-1", hours: 99, description: "x" },
    });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual({ error: "Too many hours" });
  });

  it("fails a read with a sentence, and never prints the key", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clockout-next-pms-"));
    const wrong = join(dir, "next-pms.json");
    await writeFile(wrong, JSON.stringify({ url: origin, api_key: "k1", api_secret: "nope" }), {
      mode: 0o600,
    });
    const r = await run({ op: "day", date: "2026-10-27" }, wrong);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("refused the API key");
    expect(r.stdout + r.stderr).not.toContain("nope");
  });

  it("refuses settings others can read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clockout-next-pms-"));
    const open = join(dir, "next-pms.json");
    await writeFile(open, JSON.stringify({ url: origin, api_key: "k1", api_secret: "s1" }));
    await chmod(open, 0o644);
    const r = await run({ op: "day", date: "2026-10-27" }, open);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("chmod 600");
  });
});
