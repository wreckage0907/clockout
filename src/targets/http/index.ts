import { z } from "zod";
import { plainText, type RemoteDay, roundHours } from "../../core/push";
import type { Fetch } from "../../oauth";
import type { EntryInput, RemoteTask, Target } from "../types";

// Any timesheet or PMS system that speaks a small JSON API (docs/timesheet-api.md), with a
// bearer token. Its own rules (which tasks exist, hour limits, approvals) stay on its side; a
// refused write comes back as `{ "error": "…" }` and is shown as it's written.

const entries = z.object({
  entries: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      task: z.string(),
      hours: z.number(),
      description: z.string().nullable().default(""),
      locked: z.string().nullable().optional(),
    }),
  ),
  closed: z.string().nullable().optional(),
});

const tasks = z.object({
  tasks: z.array(
    z.object({
      id: z.union([z.string(), z.number()]).transform(String),
      subject: z.string().nullable().optional(),
      project: z.string().nullable().optional(),
    }),
  ),
});

const failure = z.object({ error: z.string() });

export function httpTarget(
  url: string,
  token: string,
  tokenSource: string,
  doFetch: Fetch = fetch,
): Target {
  const base = url.replace(/\/+$/, "");
  const host = new URL(base).host;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch((err: unknown) => {
      throw new Error(`Couldn't reach ${host}. Check the address and your connection.`, {
        cause: err,
      });
    });
    const json = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.ok) return json;
    const said = failure.safeParse(json);
    if (res.status === 401 || res.status === 403)
      throw new Error(
        `${host} refused the token in ${tokenSource}${said.success ? ` (${plainText(said.data.error)})` : ""}. Check it, or get a new one.`,
      );
    if (res.status >= 500)
      throw new Error(
        `${host} isn't answering right now (HTTP ${res.status}${said.success ? `: ${plainText(said.data.error)}` : ""}). Try again later.`,
      );
    // A read answered 404: the address is wrong. A write's 404 is about the entry, in its words.
    if (res.status === 404 && method === "GET")
      throw new Error(`There's no timesheet API at ${base}. Check the address in config.toml.`);
    if (said.success) throw new Error(plainText(said.data.error));
    throw new Error(`${host} answered HTTP ${res.status}.`);
  }

  const shaped = <T>(schema: z.ZodType<T>, raw: unknown, what: string): T => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success)
      throw new Error(`${host} sent ${what} in a shape Clockout can't read.`, {
        cause: parsed.error,
      });
    return parsed.data;
  };

  const entryBody = (date: string, e: EntryInput) => ({
    date,
    task: e.task,
    hours: e.hours,
    description: e.description,
  });

  return {
    id: "http",
    name: host,

    async day(date) {
      const raw = await call("GET", `/entries?${new URLSearchParams({ date })}`);
      const day = shaped(entries, raw, "entries");
      return {
        entries: day.entries.map((e) => ({
          id: e.id,
          parent: "",
          task: e.task,
          hours: roundHours(e.hours),
          description: plainText(e.description ?? ""),
          ...(e.locked ? { locked: e.locked } : {}),
        })),
        ...(day.closed ? { closed: day.closed } : {}),
      } satisfies RemoteDay;
    },

    async searchTasks(query) {
      const raw = await call("GET", `/tasks?${new URLSearchParams({ search: query })}`);
      return shaped(tasks, raw, "tasks").tasks.map(
        (t): RemoteTask => ({ id: t.id, subject: t.subject ?? t.id, project: t.project ?? "" }),
      );
    },

    async create(date, e) {
      await call("POST", "/entries", entryBody(date, e));
    },

    async update(date, id, _parent, e) {
      await call("PUT", `/entries/${encodeURIComponent(id)}`, entryBody(date, e));
    },

    async remove(id) {
      await call("DELETE", `/entries/${encodeURIComponent(id)}`);
    },
  };
}
