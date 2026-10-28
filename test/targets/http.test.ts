import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { configSchema } from "../../src/config/schema";
import { openTarget } from "../../src/targets";
import { httpTarget } from "../../src/targets/http";
import { type MockPms, startMockPms } from "../mock-pms/server";

const DATE = "2026-10-16";
let pms: MockPms;
beforeAll(async () => {
  pms = await startMockPms();
});
afterAll(() => pms.stop());

const target = (token = pms.token) => httpTarget(pms.url, token, "CLOCKOUT_TIMESHEET_TOKEN");

describe("http timesheet target", () => {
  it("creates, reads, updates and deletes entries, and searches tasks", async () => {
    const t = target();
    await t.create(DATE, { task: "TASK-API", hours: 1.5, description: "Fix <b>auth</b>" });
    const [entry] = (await t.day(DATE)).entries;
    expect(entry).toEqual({
      id: "E1",
      parent: "",
      task: "TASK-API",
      hours: 1.5,
      description: "Fix auth",
    });
    await t.update(DATE, "E1", "", { task: "TASK-TOOLS", hours: 2, description: "Tooling" });
    expect(pms.day(DATE)[0]).toMatchObject({ task: "TASK-TOOLS", hours: 2 });
    await t.remove("E1", "");
    expect((await t.day(DATE)).entries).toEqual([]);
    expect(await t.searchTasks("tool")).toEqual([
      { id: "TASK-TOOLS", subject: "Developer tooling", project: "Internal" },
    ]);
  });

  it("reads approved entries and closed days as locked", async () => {
    const t = target();
    await t.create(DATE, { task: "TASK-API", hours: 1, description: "Locked" });
    const id = pms.day(DATE)[0]?.id ?? "";
    pms.lock(id);
    pms.closeDate("2026-10-17");
    expect((await t.day(DATE)).entries[0]?.locked).toBe("Approved by your manager.");
    expect((await t.day("2026-10-17")).closed).toBe("This week is already approved.");
    await expect(t.remove(id, "")).rejects.toThrow("Approved by your manager.");
  });

  it("shows the system's own reason for a refused write", async () => {
    await expect(
      target().create(DATE, { task: "TASK-NONE", hours: 1, description: "x" }),
    ).rejects.toThrow("There's no task TASK-NONE.");
    await expect(
      target().create(DATE, { task: "TASK-API", hours: 30, description: "x" }),
    ).rejects.toThrow("Hours must be more than 0 and at most 24.");
  });

  it("cleans the system's words of escape codes before they become an error", async () => {
    const hostile = "Nope\u001b]52;c;ZXZpbA==\u0007\u001b[2J‮";
    for (const status of [400, 401, 500]) {
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(Response.json({ error: hostile }, { status }));
      const err = (await target()
        .create(DATE, { task: "TASK-API", hours: 1, description: "x" })
        .catch((e: Error) => e)) as Error;
      spy.mockRestore();
      expect(err.message).toContain("Nope");
      // biome-ignore lint/suspicious/noControlCharactersInRegex: that's what the test is about
      expect(err.message).not.toMatch(/[\u0000-\u001f\u007f-\u009f‮]/);
    }
  });

  it("names the token's variable when it's refused, never the token", async () => {
    const err = await target("wrong-secret")
      .day(DATE)
      .catch((e: Error) => e);
    expect((err as Error).message).toContain("refused the token in CLOCKOUT_TIMESHEET_TOKEN");
    expect((err as Error).message).not.toContain("wrong-secret");
  });

  it("says when there's no API at the address, or nothing listening", async () => {
    const wrongPath = httpTarget(`${new URL(pms.url).origin}/nope`, pms.token, "T");
    await expect(wrongPath.day(DATE)).rejects.toThrow("There's no timesheet API at");
    const nobody = httpTarget("http://127.0.0.1:9/api", pms.token, "T");
    await expect(nobody.day(DATE)).rejects.toThrow("Couldn't reach 127.0.0.1:9.");
  });
});

describe("opening an http target from config", () => {
  const config = (extra: object = {}) =>
    configSchema.parse({
      me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
      timesheet: { type: "http", url: pms.url, ...extra },
    });

  it("takes the token from the variable it names, and says which one to set", async () => {
    await expect(openTarget(config(), { env: {} })).rejects.toThrow(
      "Set CLOCKOUT_TIMESHEET_TOKEN to your timesheet API's token",
    );
    await expect(openTarget(config({ token_env: "PMS_TOKEN" }), { env: {} })).rejects.toThrow(
      "Set PMS_TOKEN to your timesheet API's token",
    );
    const t = await openTarget(config({ token_env: "PMS_TOKEN" }), {
      env: { PMS_TOKEN: pms.token },
    });
    expect(await t?.searchTasks("")).toHaveLength(3);
  });

  it("takes the token from config.toml itself when it's there", async () => {
    const t = await openTarget(config({ token: pms.token }), { env: {} });
    expect(await t?.searchTasks("")).toHaveLength(3);
  });

  it("wants exactly one of token and token_env, and a token with no spaces", () => {
    const issues = (extra: object) => {
      const r = configSchema.safeParse({
        me: { name: "Dev", emails: ["dev@example.com"], timezone: "UTC" },
        timesheet: { type: "http", url: pms.url, ...extra },
      });
      return r.success ? [] : [...new Set(r.error.issues.map((i) => i.path.join(".")))];
    };
    expect(issues({ token: "abc", token_env: "PMS_TOKEN" })).toEqual(["timesheet.token"]);
    expect(issues({ token: "two words" })).toEqual(["timesheet.token"]);
    expect(issues({ token: "" })).toEqual(["timesheet.token"]);
    expect(issues({ token: "abc" })).toEqual([]);
    expect(issues({})).toEqual([]);
  });

  it("refuses plain http off this machine", () => {
    expect(() =>
      configSchema.parse({
        me: { name: "Dev", emails: ["dev@example.com"], timezone: "UTC" },
        timesheet: { type: "http", url: "http://pms.example.com/api" },
      }),
    ).toThrow("https");
  });

  it("says config.toml, never the token, when the system refuses the one in it", async () => {
    const t = await openTarget(config({ token: "wrong-inline-secret" }), { env: {} });
    const err = await t?.day(DATE).catch((e: Error) => e);
    expect((err as Error).message).toContain("refused the token in config.toml");
    expect((err as Error).message).not.toContain("wrong-inline-secret");
  });

  it("blanks the token out of anything a server says back, wherever it came from", async () => {
    const echo = async (_url: string | URL | Request, init?: RequestInit) => {
      const sent = new Headers(init?.headers).get("authorization") ?? "";
      return new Response(JSON.stringify({ error: `Bad request (${sent})` }), { status: 400 });
    };
    for (const [extra, env] of [
      [{ token: "inline-secret-123" }, {}],
      [{ token_env: "PMS_TOKEN" }, { PMS_TOKEN: "inline-secret-123" }],
    ] as const) {
      const t = await openTarget(config(extra), { env, fetch: echo });
      const err = await t
        ?.create(DATE, { task: "TASK-API", hours: 1, description: "x" })
        .catch((e: Error) => e);
      expect((err as Error).message).toContain("Bad request");
      expect((err as Error).message).not.toContain("inline-secret-123");
    }
  });
});
