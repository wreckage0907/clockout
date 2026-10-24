import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DATE,
  fakeServer,
  fixtureJson,
  fixtureSourcesToml,
  type Request,
  type Sandbox,
  sandbox,
} from "./helpers";

// `clockout push` against a fake next-pms site on 127.0.0.1: OAuth refresh with rotating tokens,
// and timesheet entries kept in memory the way next-pms returns them.

interface Entry {
  name: string;
  parent: string;
  task: string;
  hours: number;
  description: string;
  from_time: string;
}

const API = "/api/method/next_pms.timesheet.api";
/** The fixture day has three meetings nobody answered; push says they wait. */
const WAITING = "3 meetings waiting for an answer aren't sent. Run `clockout` to review.\n";
const TOKEN = "/api/method/frappe.integrations.oauth2.get_token";
const REVOKE = "/api/method/frappe.integrations.oauth2.revoke_token";

function erpSite(employee: unknown) {
  const entries: Entry[] = [];
  let issued = 0;
  let revokedSignIn = false;
  let n = 0;
  const handle = (r: Request, origin: string): { status?: number; json: unknown } => {
    const body = r.body
      ? r.headers["content-type"]?.includes("json")
        ? JSON.parse(r.body)
        : Object.fromEntries(new URLSearchParams(r.body))
      : {};
    switch (r.path) {
      case "/.well-known/oauth-authorization-server":
        return {
          json: {
            issuer: origin,
            authorization_endpoint: `${origin}/api/method/frappe.integrations.oauth2.authorize`,
            token_endpoint: `${origin}${TOKEN}`,
            revocation_endpoint: `${origin}${REVOKE}`,
          },
        };
      case TOKEN:
        if (revokedSignIn) return { status: 403, json: { exc_type: "PermissionError" } };
        issued++;
        return {
          json: { access_token: `at-${issued}`, expires_in: 3600, refresh_token: `rt-${issued}` },
        };
      case REVOKE:
        return { json: {} };
    }
    if (r.headers.authorization !== `Bearer at-${issued}`)
      return { status: 401, json: { exc_type: "AuthenticationError" } };
    switch (r.path) {
      case `${API}.employee.get_data`:
        return { json: employee };
      case `${API}.timesheet.get_timesheet_data`: {
        const tasks: Record<string, { data: Entry[] }> = {};
        for (const e of entries) {
          tasks[e.task] ??= { data: [] };
          tasks[e.task]?.data.push(e);
        }
        const dates = Array.from({ length: 7 }, (_, i) => `2026-10-${12 + i}`);
        return { json: { message: { data: { week: { dates, status: "Not Submitted", tasks } } } } };
      }
      case `${API}.timesheet.save`:
        entries.push({
          name: `row-${++n}`,
          parent: "TS-1",
          task: body.task,
          hours: body.hours,
          description: body.description,
          from_time: `${body.date} 00:00:00`,
        });
        return { json: { message: "ok" } };
      case `${API}.timesheet.update_timesheet_detail`: {
        const e = entries.find((x) => x.name === body.name);
        if (e)
          Object.assign(e, { task: body.task, hours: body.hours, description: body.description });
        return { json: { message: "ok" } };
      }
      case `${API}.timesheet.delete`:
        entries.splice(
          entries.findIndex((x) => x.name === body.name),
          1,
        );
        return { json: { message: "ok" } };
    }
    return { status: 404, json: {} };
  };
  return {
    entries,
    handle,
    revokeSignIn: () => {
      revokedSignIn = true;
    },
  };
}

let sb: Sandbox;
let site: ReturnType<typeof erpSite>;
let server: Awaited<ReturnType<typeof fakeServer>>;
const credentials = () => join(sb.config, "credentials.json");
const writes = () =>
  server.requests.filter((r) => /timesheet\.(save|update_timesheet_detail|delete)$/.test(r.path));

beforeAll(async () => {
  sb = await sandbox();
  site = erpSite(await fixtureJson("next-pms/employee.json"));
  server = await fakeServer((r, origin) => site.handle(r, origin));
  const map = [
    ["Meetings", "TASK-MEET"],
    ["acme/api", "TASK-API"],
    ["dev-example/clockout", "TASK-TOOLS"],
  ]
    .map(([project, task]) => `\n[[timesheet.map]]\nproject = "${project}"\nerp_task = "${task}"`)
    .join("\n");
  await sb.writeConfig(
    await fixtureSourcesToml(
      sb,
      `\n[timesheet]\ntype = "next-pms"\nurl = "${server.origin}"\n${map}\n`,
    ),
  );
  await writeFile(
    credentials(),
    JSON.stringify({
      erp: { url: server.origin, client_id: "cid", refresh_token: "rt-0", connected_at: DATE },
    }),
    { mode: 0o600 },
  );
});
afterAll(() => server.close());

describe("sending a day to the ERP", () => {
  it("shows what it would send and writes nothing on a dry run", async () => {
    const r = await sb.run(["push", DATE, "--dry-run", "--no-ai"]);
    expect(r.stderr).toBe(WAITING);
    expect(r.code).toBe(0);
    expect(r.stdout.split("\n")[0]).toBe(`${DATE} → ${server.origin}`);
    expect(r.stdout).toContain("+ ");
    expect(writes()).toEqual([]);
  });

  it("sends every row once, keeps the rotated sign-in and revokes the old one", async () => {
    const r = await sb.run(["push", DATE, "--yes", "--no-ai"]);
    expect(r.stderr).toBe(WAITING);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Sent 8 changes.");
    // The local sources only (no GitHub here): every row, on the task its project maps to.
    expect(site.entries.map((e) => [e.task, e.hours, e.description])).toEqual([
      ["TASK-MEET", 0.5, "Daily standup"],
      ["TASK-API", 2, "Fix auth token refresh"],
      ["TASK-API", 0.25, "Rate limit the login endpoint"],
      ["TASK-API", 0.5, "Fix rate limit"],
      ["TASK-API", 0.25, "Paginate the invoices endpoint"],
      ["TASK-TOOLS", 2.5, "Build export command"],
      ["TASK-API", 0.25, "Investigate flaky deploy"],
      ["TASK-TOOLS", 0.25, "Work on dev-example/clockout"],
    ]);
    const saved = JSON.parse(await readFile(credentials(), "utf8"));
    expect(saved.erp.refresh_token).not.toBe("rt-0");
    const revoked = server.requests.filter((x) => x.path === REVOKE);
    expect(new URLSearchParams(revoked[0]?.body).get("token")).toBe("rt-0");
  });

  it("sends nothing the second time", async () => {
    const before = writes().length;
    const r = await sb.run(["push", DATE, "--yes", "--no-ai"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Nothing to send.");
    expect(writes()).toHaveLength(before);
  });

  it("adds back an entry deleted in the ERP, and only that one", async () => {
    const gone = site.entries.splice(0, 1)[0];
    const r = await sb.run(["push", DATE, "--yes", "--no-ai"]);
    expect(r.stdout).toContain("Sent 1 change.");
    expect(site.entries).toHaveLength(8);
    expect(site.entries.at(-1)?.description).toBe(gone?.description);
  });

  it("asks you to connect again once the sign-in is revoked, and writes nothing", async () => {
    site.revokeSignIn();
    const before = writes().length;
    const r = await sb.run(["push", DATE, "--yes", "--no-ai"]);
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain(
      "\nclockout: The ERP sign-in expired or was revoked. Run `clockout connect erp <url>` again.\n",
    );
    expect(writes()).toHaveLength(before);
  });
});
