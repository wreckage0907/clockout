import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { CONTRIBUTIONS_QUERY, createGitHubSource } from "../../src/sources/github";

const fixture = new URL("../fixtures/github/contributions-2026-10-16.json", import.meta.url);
const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
});
const ctx = { config, homeDir: "/home/dev", env: {} };

async function collect(response: unknown, date = "2026-10-16") {
  const calls: Record<string, unknown>[] = [];
  const source = createGitHubSource(async (query, vars) => {
    expect(query).toBe(CONTRIBUTIONS_QUERY);
    calls.push(vars);
    return response;
  });
  const out: Activity[] = [];
  for await (const a of source.collect(dayRange(date, "Asia/Kolkata"), { type: "github" }, ctx))
    out.push(a);
  return { out, calls };
}

describe("github source", async () => {
  const response = JSON.parse(await readFile(fixture, "utf8"));

  it("asks for the local day as a UTC range", async () => {
    const { calls } = await collect(response);
    expect(calls).toEqual([{ from: "2026-10-15T18:30:00.000Z", to: "2026-10-16T18:30:00.000Z" }]);
  });

  it("turns opened PRs into human activity with branch and ref", async () => {
    const prs = (await collect(response)).out.filter((a) => a.kind === "pr");
    expect(prs).toEqual([
      expect.objectContaining({
        start: new Date("2026-10-16T06:07:00Z"),
        title: "Fix auth token refresh race",
        repo: "acme/api",
        branch: "fix/auth-refresh",
        refs: ["pr:acme/api#87"],
      }),
      expect.objectContaining({
        repo: "dev-example/clockout",
        refs: ["pr:dev-example/clockout#48"],
      }),
    ]);
  });

  it("emits each review comment and the review submission", async () => {
    const review = (await collect(response)).out.filter((a) => a.kind.startsWith("review"));
    expect(review.map((a) => [a.kind, a.start.toISOString().slice(11, 16)])).toEqual([
      ["review_comment", "11:10"],
      ["review_comment", "11:16"],
      ["review_comment", "11:22"],
      ["review", "11:25"],
    ]);
    expect(review[0]?.refs).toEqual(["pr:acme/api#212", "author:sam-example"]);
  });

  it("drops contributions outside the day", async () => {
    expect((await collect(response, "2026-10-17")).out).toEqual([]);
  });

  it("explains an unexpected response", async () => {
    await expect(collect({ data: { viewer: null } })).rejects.toThrow(/unexpected response/);
  });
});
