#!/usr/bin/env node
// A `command` timesheet target for next-pms (Frappe/ERPNext), kept outside Clockout
// itself (ADR 0013). Clockout runs it with one JSON request on stdin and reads one JSON answer on
// stdout, in the shapes of docs/timesheet-api.md. It calls the same whitelisted methods next-pms's
// own web app calls, so all of next-pms's rules apply.
//
// Setting it up (an API key, a settings file only you can read, the [timesheet] section):
// docs/next-pms-setup.md.
// No dependencies: Node 22.12 or newer.

import { realpathSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const API = "next_pms.timesheet.api";
const TIMEOUT_MS = 30_000;

/** A read that fails exits 1 (Clockout shows stderr's last line); a refused write answers `{ error }`. */
class Refusal extends Error {}

function settingsPath(env = process.env) {
  if (env.NEXT_PMS_SETTINGS) return env.NEXT_PMS_SETTINGS;
  const config = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(config, "clockout", "next-pms.json");
}

async function loadSettings(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new Error(
      `No next-pms settings at ${path}. Write { "url", "api_key", "api_secret" } there (chmod 600).`,
    );
  }
  if (process.platform !== "win32" && ((await stat(path)).mode & 0o077) !== 0)
    throw new Error(`${path} can be read by others; run \`chmod 600 ${path}\` first.`);
  let s;
  try {
    s = JSON.parse(text);
  } catch {
    throw new Error(`${path} isn't valid JSON.`);
  }
  for (const key of ["url", "api_key", "api_secret"])
    if (typeof s?.[key] !== "string" || !s[key])
      throw new Error(`${path} needs a "${key}" (a string).`);
  const url = new URL(s.url);
  const local =
    ["localhost", "127.0.0.1"].includes(url.hostname) || url.hostname.endsWith(".localhost");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local))
    throw new Error(`${s.url} must be https (plain http only on this machine).`);
  return { origin: url.origin, auth: `token ${s.api_key}:${s.api_secret}` };
}

/** Text without HTML or control characters, on one line. */
function plain(text) {
  return (
    String(text ?? "")
      // Whole escape sequences first (CSI, then OSC), so nothing of them is left behind.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
      .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
      .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      .replace(/[\u0000-\u001f\u007f-\u009f\p{Cf}]/gu, " ")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/** The readable message in a Frappe error response. */
export function frappeError(body, status) {
  if (/is not installed|Failed to get method|is not whitelisted/.test(JSON.stringify(body ?? "")))
    return "This ERP doesn't have next-pms, or its version is too old. Check with whoever runs it.";
  if (typeof body?._server_messages === "string") {
    try {
      const msgs = JSON.parse(body._server_messages)
        .map((m) => {
          try {
            return plain(JSON.parse(m).message);
          } catch {
            return plain(m);
          }
        })
        .filter(Boolean);
      if (msgs.length) return msgs.join(" ");
    } catch {
      // fall through
    }
  }
  if (typeof body?.exception === "string")
    return plain(body.exception.replace(/^[\w.]+(Error|Exception): /, ""));
  if (status === 401 || status === 403)
    return "The ERP refused the API key. Check api_key and api_secret in your next-pms settings.";
  if (status >= 500) return `The ERP isn't answering right now (HTTP ${status}). Try again later.`;
  return `The ERP answered HTTP ${status}.`;
}

export function nextPms({ origin, auth }, doFetch = fetch) {
  async function call(method, { get, post } = {}) {
    const q = get ? `?${new URLSearchParams(get)}` : "";
    const res = await doFetch(`${origin}/api/method/${method}${q}`, {
      method: post ? "POST" : "GET",
      headers: {
        authorization: auth,
        accept: "application/json",
        ...(post ? { "content-type": "application/json" } : {}),
      },
      ...(post ? { body: JSON.stringify(post) } : {}),
      // The key is a secret: never hand it to wherever a redirect points.
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }).catch(() => {
      throw new Error(`Couldn't reach ${origin}.`);
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Refusal(frappeError(body, res.status));
    return body?.message;
  }

  let employee;
  async function me() {
    employee ??= call(`${API}.employee.get_data`, { get: {} }).then((m) => {
      if (!m?.employee)
        throw new Error("Your ERP user isn't linked to an employee, so it can't log time.");
      return m.employee;
    });
    return employee;
  }

  // Clockout's entries are a flat list; next-pms needs the timesheet (parent) to change one, so
  // it travels inside the id.
  const idOf = (parent, name) => `${parent}::${name}`;
  const split = (id) => {
    const at = String(id).lastIndexOf("::");
    if (at < 0) throw new Refusal(`${id} isn't an entry this program gave out.`);
    return { parent: String(id).slice(0, at), name: String(id).slice(at + 2) };
  };

  return {
    async day({ date }) {
      const raw = await call(`${API}.timesheet.get_timesheet_data`, {
        get: { employee: await me(), start_date: date, max_week: "1" },
      });
      const week = Object.values(raw?.data ?? {}).find((w) => w?.dates?.includes(date));
      const entries = [];
      for (const [task, t] of Object.entries(week?.tasks ?? {})) {
        for (const e of t?.data ?? []) {
          if (!String(e.from_time ?? "").startsWith(date)) continue;
          const locked =
            e.docstatus === 1
              ? "Already approved in the ERP."
              : (e.rejected_hours ?? 0) > 0
                ? "Rejected in the ERP; rejected entries can't be changed."
                : undefined;
          entries.push({
            id: idOf(e.parent, e.name),
            task: e.task ?? task,
            hours: e.hours ?? 0,
            description: plain(e.description),
            ...(locked ? { locked } : {}),
          });
        }
      }
      return {
        entries,
        ...(week?.status === "Approved"
          ? { closed: "This week is already approved in the ERP." }
          : {}),
      };
    },

    async tasks({ search }) {
      const raw = await call(`${API}.task.get_task_list`, {
        get: { search: search ?? "", page_length: "30" },
      });
      return {
        tasks: (raw?.task ?? []).map((t) => ({
          id: t.name,
          subject: t.subject ?? t.name,
          project: t.project_name ?? t.project ?? "",
        })),
      };
    },

    async create({ date, entry }) {
      await call(`${API}.timesheet.save`, {
        post: { date, task: entry.task, hours: entry.hours, description: entry.description },
      });
      // next-pms's save doesn't return the new entry; Clockout reads the day again to find it.
      return {};
    },

    async update({ date, id, entry }) {
      const { parent, name } = split(id);
      await call(`${API}.timesheet.update_timesheet_detail`, {
        post: {
          name,
          parent,
          date,
          task: entry.task,
          hours: entry.hours,
          description: entry.description,
        },
      });
      return {};
    },

    async delete({ id }) {
      const { parent, name } = split(id);
      await call(`${API}.timesheet.delete`, { post: { parent, name } });
      return {};
    },
  };
}

async function main() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  const request = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  const target = nextPms(await loadSettings(settingsPath()));
  const op = target[request.op];
  if (!op) throw new Error(`Unknown request "${request.op}".`);
  try {
    process.stdout.write(`${JSON.stringify(await op(request))}\n`);
  } catch (err) {
    // A refused write is shown next to its row; a read that fails stops the send.
    if (err instanceof Refusal && ["create", "update", "delete"].includes(request.op)) {
      process.stdout.write(`${JSON.stringify({ error: err.message })}\n`);
      return;
    }
    throw err;
  }
}

/** Run as a program, not imported (by its tests). */
const isMain = () => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (isMain()) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
