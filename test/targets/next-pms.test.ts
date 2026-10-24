import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { openTarget } from "../../src/targets";
import { frappeError, nextPms } from "../../src/targets/next-pms";
import type { ErpAuth } from "../../src/targets/next-pms/oauth";

const fixtures = new URL("../fixtures/next-pms/", import.meta.url);
const load = async (name: string) =>
  JSON.parse(await readFile(new URL(name, fixtures), "utf8")) as unknown;

interface Sent {
  method: string;
  url: URL;
  auth: string | null;
  body: unknown;
}

/** A Frappe site in memory: answers from fixtures and records every request. */
async function site(opts: { expired?: string } = {}) {
  const sent: Sent[] = [];
  const answers: Record<string, unknown> = {
    "next_pms.timesheet.api.employee.get_data": await load("employee.json"),
    "next_pms.timesheet.api.timesheet.get_timesheet_data": await load(
      "timesheet-data-2026-10-16.json",
    ),
    "next_pms.timesheet.api.task.get_task_list": await load("task-list.json"),
  };
  const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    sent.push({
      method: init?.method ?? "GET",
      url,
      auth,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (opts.expired && auth === `Bearer ${opts.expired}`)
      return Response.json({ exc_type: "AuthenticationError" }, { status: 401 });
    const method = url.pathname.replace("/api/method/", "");
    if (
      method === "next_pms.timesheet.api.timesheet.save" &&
      String(init?.body).includes('"2026-09-01"')
    )
      return Response.json(await load("validation-error.json"), { status: 417 });
    return Response.json(answers[method] ?? { message: "ok" });
  }) as typeof fetch;
  return { sent, doFetch };
}

const tokens = (...list: string[]): ErpAuth & { forced: number } => {
  const auth = {
    forced: 0,
    async token(force?: boolean) {
      if (force) auth.forced++;
      return list[Math.min(auth.forced, list.length - 1)] as string;
    },
  };
  return auth;
};

describe("next-pms target", () => {
  it("reads your entries for one day, as plain text, with locks", async () => {
    const { sent, doFetch } = await site();
    const day = await nextPms("https://erp.example.com", tokens("at"), doFetch).day("2026-10-16");
    expect(day.closed).toBeUndefined();
    expect(day.entries).toEqual([
      {
        id: "row-auth",
        parent: "TS-0002",
        task: "TASK-0001",
        hours: 2.25,
        description: "Fix auth token refresh & retries",
      },
      {
        id: "row-standup",
        parent: "TS-0003",
        task: "TASK-0002",
        hours: 0.25,
        description: "Daily standup",
        locked: "Already approved in the ERP.",
      },
      {
        id: "row-rejected",
        parent: "TS-0003",
        task: "TASK-0002",
        hours: 0,
        description: "Planning",
        locked: "Rejected in the ERP; rejected entries can't be changed.",
      },
    ]);
    const read = sent.at(-1) as Sent;
    expect(Object.fromEntries(read.url.searchParams)).toEqual({
      employee: "EMP-0001",
      start_date: "2026-10-16",
      max_week: "1",
    });
    expect(sent.every((s) => s.auth === "Bearer at")).toBe(true);
  });

  it("searches tasks you can log against", async () => {
    const { sent, doFetch } = await site();
    const tasks = await nextPms("https://erp.example.com", tokens("at"), doFetch).searchTasks(
      "api",
    );
    expect(tasks).toEqual([
      { id: "TASK-0001", subject: "API maintenance", project: "Acme API" },
      { id: "TASK-0003", subject: "Clockout development", project: "PROJ-0003" },
    ]);
    expect(sent[0]?.url.searchParams.get("search")).toBe("api");
  });

  it("creates, updates and deletes through next-pms's own methods", async () => {
    const { sent, doFetch } = await site();
    const t = nextPms("https://erp.example.com/app/timesheet", tokens("at"), doFetch);
    const e = { task: "TASK-0001", hours: 1.5, description: "Fix auth" };
    await t.create("2026-10-16", e);
    await t.update("2026-10-16", "row-auth", "TS-0002", e);
    await t.remove("row-auth", "TS-0002");
    expect(sent.map((s) => [s.method, s.url.href, s.body])).toEqual([
      [
        "POST",
        "https://erp.example.com/api/method/next_pms.timesheet.api.timesheet.save",
        { date: "2026-10-16", ...e },
      ],
      [
        "POST",
        "https://erp.example.com/api/method/next_pms.timesheet.api.timesheet.update_timesheet_detail",
        { name: "row-auth", parent: "TS-0002", date: "2026-10-16", ...e },
      ],
      [
        "POST",
        "https://erp.example.com/api/method/next_pms.timesheet.api.timesheet.delete",
        { parent: "TS-0002", name: "row-auth" },
      ],
    ]);
  });

  it("says why the ERP refused, in its own words", async () => {
    const { doFetch } = await site();
    const t = nextPms("https://erp.example.com", tokens("at"), doFetch);
    await expect(
      t.create("2026-09-01", { task: "TASK-0001", hours: 1, description: "x" }),
    ).rejects.toThrow(
      "Backdated time entries are not allowed. The earliest date you can log time for is 01-10-2026.",
    );
    expect(
      frappeError(
        { exception: "frappe.exceptions.ValidationError: Hour should be greater than 0." },
        417,
      ),
    ).toBe("Hour should be greater than 0.");
    expect(frappeError(null, 403)).toContain("clockout connect erp");
  });

  it("refreshes the sign-in once when the ERP rejects the access token", async () => {
    const { sent, doFetch } = await site({ expired: "old" });
    const auth = tokens("old", "new");
    await nextPms("https://erp.example.com", auth, doFetch).searchTasks("");
    expect(auth.forced).toBe(1);
    expect(sent.map((s) => s.auth)).toEqual(["Bearer old", "Bearer new"]);
  });
});

describe("openTarget", () => {
  const config = (timesheet?: unknown) =>
    configSchema.parse({
      me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
      ...(timesheet ? { timesheet } : {}),
    });

  it("is null when no ERP is set up, and asks you to connect when not signed in", async () => {
    expect(await openTarget(config(), { credentials: async () => null })).toBeNull();
    const c = config({ type: "next-pms", url: "https://erp.example.com" });
    await expect(openTarget(c, { credentials: async () => null })).rejects.toThrow(
      "clockout connect erp https://erp.example.com",
    );
    const other = {
      url: "https://other.example.com",
      client_id: "c",
      refresh_token: "r",
      connected_at: "",
    };
    await expect(openTarget(c, { credentials: async () => other })).rejects.toThrow(
      "Not signed in",
    );
  });

  it("accepts https sites, and plain http only on this machine", () => {
    expect(() => config({ type: "next-pms", url: "http://erp.example.com" })).toThrow("https");
    expect(config({ type: "next-pms", url: "http://erp.localhost" }).timesheet?.map).toEqual([]);
  });
});
