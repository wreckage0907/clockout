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
      ["review_comment", "11:24"],
    ]);
    expect(review[0]).toMatchObject({
      refs: ["pr:acme/api#212", "author:sam-example"],
      branch: "feat/login-rate-limit",
    });
  });

  it("emits your comments on issues, and on someone else's PR as part of reviewing it", async () => {
    const { out } = await collect(response);
    expect(out.filter((a) => a.kind === "comment")).toEqual([
      {
        source: "github",
        kind: "comment",
        actor: "human",
        start: new Date("2026-10-16T05:20:00Z"),
        title: "Token refresh logs users out",
        repo: "acme/api",
        refs: ["issue:acme/api#90"],
      },
    ]);
    expect(
      out.find(
        (a) =>
          a.kind === "review_comment" &&
          a.start.getUTCHours() === 11 &&
          a.start.getUTCMinutes() === 24,
      ),
    ).toMatchObject({ branch: "feat/login-rate-limit" });
  });

  it("keeps a comment on your own PR with the work on its branch, and emits issues you opened", async () => {
    const own = structuredClone(response);
    own.data.viewer.issueComments.nodes = [
      {
        createdAt: "2026-10-16T11:00:00Z",
        issue: {
          number: 48,
          title: "Add CSV export",
          repository: { nameWithOwner: "dev-example/clockout" },
        },
        pullRequest: { number: 48, headRefName: "feat/export", author: { login: "dev-example" } },
      },
    ];
    own.data.viewer.contributionsCollection.issueContributions.nodes = [
      {
        issue: {
          number: 91,
          title: "Export drops rows past midnight",
          createdAt: "2026-10-16T12:00:00Z",
          repository: { nameWithOwner: "dev-example/clockout" },
        },
      },
    ];
    const { out } = await collect(own);
    expect(out.filter((a) => a.kind === "comment" || a.kind === "issue")).toEqual([
      expect.objectContaining({
        kind: "issue",
        title: "Export drops rows past midnight",
        refs: ["issue:dev-example/clockout#91"],
      }),
      expect.objectContaining({
        kind: "comment",
        branch: "feat/export",
        refs: ["pr:dev-example/clockout#48", "author:dev-example"],
      }),
    ]);
  });

  it("drops contributions outside the day", async () => {
    expect((await collect(response, "2026-10-17")).out).toEqual([]);
  });

  it("explains an unexpected response", async () => {
    await expect(collect({ data: { viewer: null } })).rejects.toThrow(/unexpected response/);
  });
});
