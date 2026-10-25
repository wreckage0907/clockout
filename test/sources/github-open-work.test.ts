import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { OPEN_WORK_QUERY, openWork } from "../../src/sources/github/open-work";

const fixture = new URL("../fixtures/github/open-work.json", import.meta.url);

describe("open work on GitHub", async () => {
  const response = JSON.parse(await readFile(fixture, "utf8"));

  it("reads your open PRs, reviews asked of you and finished branches", async () => {
    const work = await openWork({}, "Asia/Kolkata", async (query) => {
      expect(query).toBe(OPEN_WORK_QUERY);
      return response;
    });
    expect(work).toEqual({
      prs: [
        {
          repo: "acme/api",
          number: 88,
          title: "Rate limit the login endpoint",
          branch: "feat/login-rate-limit",
        },
        // Titles are plain text: no terminal escapes.
        {
          repo: "dev-example/clockout",
          number: 49,
          title: "Export to CSV",
          draft: true,
          branch: "feat/export",
        },
      ],
      reviews: [
        {
          repo: "acme/web",
          number: 92,
          title: "Dark mode for the dashboard",
          author: "sam-example",
        },
      ],
      finished: { "acme/api": ["fix/auth-refresh", "chore/deps"] },
    });
  });

  it("says so when the answer has a shape it doesn't know", async () => {
    await expect(openWork({}, "Asia/Kolkata", async () => ({ viewer: {} }))).rejects.toThrow(
      "GitHub: open pull requests came back in a shape Clockout doesn't know.",
    );
  });

  it("explains a missing token without calling GitHub", async () => {
    await expect(openWork({ PATH: "" }, "Asia/Kolkata")).rejects.toThrow(
      /gh auth login|GITHUB_TOKEN/,
    );
  });
});
