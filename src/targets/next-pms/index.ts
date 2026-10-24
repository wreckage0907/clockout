import { z } from "zod";
import { plainText, type RemoteDay, type RemoteEntry, roundHours } from "../../core/push";
import type { EntryInput, RemoteTask, Target } from "../types";
import { type ErpAuth, type Fetch, siteOrigin } from "./oauth";

// next-pms (rtCamp's timesheet app on Frappe/ERPNext), through the same whitelisted methods its
// own web app calls, so all of its rules apply: a task is required, backdating windows,
// approved weeks, rejected rows.

const API = "next_pms.timesheet.api";

const entry = z.object({
  name: z.string(),
  parent: z.string(),
  task: z.string().nullable().optional(),
  hours: z.number().nullable().optional(),
  description: z.string().nullable().optional(),
  from_time: z.string(),
  docstatus: z.number().optional(),
  rejected_hours: z.number().nullable().optional(),
});

const timesheetData = z.object({
  data: z.record(
    z.string(),
    z.object({
      dates: z.array(z.string()),
      status: z.string().nullable().optional(),
      tasks: z.record(z.string(), z.object({ data: z.array(entry).default([]) })).default({}),
    }),
  ),
});

const taskList = z.object({
  task: z.array(
    z.object({
      name: z.string(),
      subject: z.string().nullable().optional(),
      project_name: z.string().nullable().optional(),
      project: z.string().nullable().optional(),
    }),
  ),
});

const employeeData = z.object({ employee: z.string().nullable() });

/** The readable message in a Frappe error response. */
export function frappeError(body: unknown, status: number): string {
  const b = (body ?? {}) as { _server_messages?: unknown; exception?: unknown; message?: unknown };
  // Every call is a next-pms method: the site doesn't have it, or one too old to have this one.
  if (/is not installed|Failed to get method|is not whitelisted/.test(JSON.stringify(body ?? "")))
    return "This ERP doesn't have next-pms, or its version is too old for Clockout. Check with whoever runs it.";
  if (typeof b._server_messages === "string") {
    try {
      const msgs = (JSON.parse(b._server_messages) as string[])
        .map((m) => {
          try {
            return plainText(String((JSON.parse(m) as { message?: unknown }).message ?? ""));
          } catch {
            return plainText(m);
          }
        })
        .filter(Boolean);
      if (msgs.length) return msgs.join(" ");
    } catch {
      // fall through
    }
  }
  if (typeof b.exception === "string") {
    return plainText(b.exception.replace(/^[\w.]+(Error|Exception): /, ""));
  }
  if (status === 401 || status === 403) {
    return "The ERP refused access. Run `clockout connect erp <url>` again.";
  }
  if (status >= 500) return `The ERP isn't answering right now (HTTP ${status}). Try again later.`;
  return `The ERP answered HTTP ${status}.`;
}

export function nextPms(url: string, auth: ErpAuth, doFetch: Fetch = fetch): Target {
  const origin = siteOrigin(url);

  async function call(
    method: string,
    opts: { get?: Record<string, string>; post?: Record<string, unknown> },
  ): Promise<unknown> {
    const send = async (force: boolean) => {
      const token = await auth.token(force);
      const headers: Record<string, string> = {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      };
      const q = opts.get ? `?${new URLSearchParams(opts.get)}` : "";
      return doFetch(`${origin}/api/method/${method}${q}`, {
        method: opts.post ? "POST" : "GET",
        headers: opts.post ? { ...headers, "content-type": "application/json" } : headers,
        ...(opts.post ? { body: JSON.stringify(opts.post) } : {}),
      }).catch(() => {
        throw new Error(`Couldn't reach ${origin}.`);
      });
    };
    let res = await send(false);
    // The access token may have been revoked or expired early: refresh once and retry.
    if (res.status === 401) res = await send(true);
    const body = (await res.json().catch(() => null)) as { message?: unknown } | null;
    if (!res.ok) throw new Error(frappeError(body, res.status));
    return body?.message;
  }

  let employee: Promise<string> | null = null;
  const me = () => {
    employee ??= call(`${API}.employee.get_data`, { get: {} }).then((m) => {
      const id = employeeData.safeParse(m);
      if (!id.success) throw new Error("The ERP sent an unexpected answer about your employee.");
      if (!id.data.employee) {
        throw new Error("Your ERP user isn't linked to an employee, so it can't log time.");
      }
      return id.data.employee;
    });
    employee.catch(() => {
      employee = null;
    });
    return employee;
  };

  return {
    id: "next-pms",
    name: "the ERP",

    async day(date) {
      const raw = await call(`${API}.timesheet.get_timesheet_data`, {
        get: { employee: await me(), start_date: date, max_week: "1" },
      });
      const parsed = timesheetData.safeParse(raw);
      if (!parsed.success)
        throw new Error("The ERP sent timesheets in a shape Clockout can't read.");
      const week = Object.values(parsed.data.data).find((w) => w.dates.includes(date));
      const entries: RemoteEntry[] = [];
      for (const [task, t] of Object.entries(week?.tasks ?? {})) {
        for (const e of t.data) {
          if (!e.from_time.startsWith(date)) continue;
          const locked =
            e.docstatus === 1
              ? "Already approved in the ERP."
              : (e.rejected_hours ?? 0) > 0
                ? "Rejected in the ERP; rejected entries can't be changed."
                : undefined;
          entries.push({
            id: e.name,
            parent: e.parent,
            task: e.task ?? task,
            hours: roundHours(e.hours ?? 0),
            description: plainText(e.description ?? ""),
            ...(locked ? { locked } : {}),
          });
        }
      }
      return {
        entries,
        ...(week?.status === "Approved"
          ? { closed: "This week is already approved in the ERP." }
          : {}),
      } satisfies RemoteDay;
    },

    async searchTasks(query) {
      const raw = await call(`${API}.task.get_task_list`, {
        get: { search: query, page_length: "30" },
      });
      const parsed = taskList.safeParse(raw);
      if (!parsed.success) throw new Error("The ERP sent tasks in a shape Clockout can't read.");
      return parsed.data.task.map(
        (t): RemoteTask => ({
          id: t.name,
          subject: t.subject ?? t.name,
          project: t.project_name ?? t.project ?? "",
        }),
      );
    },

    async create(date, e: EntryInput) {
      await call(`${API}.timesheet.save`, {
        post: { date, task: e.task, hours: e.hours, description: e.description },
      });
    },

    async update(date, id, parent, e: EntryInput) {
      await call(`${API}.timesheet.update_timesheet_detail`, {
        post: { name: id, parent, date, task: e.task, hours: e.hours, description: e.description },
      });
    },

    async remove(id, parent) {
      await call(`${API}.timesheet.delete`, { post: { parent, name: id } });
    },
  };
}
