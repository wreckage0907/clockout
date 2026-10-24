import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { configSchema } from "../../src/config/schema";
import { dayRange } from "../../src/core/time";
import type { Activity } from "../../src/core/types";
import { createGitHubSource } from "../../src/sources/github";
import { describeGitHubError } from "../../src/sources/github/errors";
import { findGitHubToken, gitHubStatus } from "../../src/sources/github/token";

const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
});
const ctx = { config, homeDir: "/home/dev", env: {} };
const TZ = "Asia/Kolkata";

/** Shaped like octokit's RequestError, with the token in the request it carries. */
function httpError(status: number, message: string, headers: Record<string, string> = {}) {
  return Object.assign(new Error(message), {
    name: "HttpError",
    status,
    request: { headers: { authorization: "token ghp_secretsecretsecretsecret" } },
    response: { status, headers, data: { message } },
  });
}

/** Shaped like @octokit/graphql's GraphqlResponseError. */
function graphqlError(errors: { type?: string; message: string }[], data: unknown = null) {
  return Object.assign(new Error("Request failed due to following response errors"), {
    name: "GraphqlResponseError",
    errors,
    data,
    headers: {},
    request: { headers: { authorization: "token ghp_secretsecretsecretsecret" } },
  });
}

async function collectWith(err: unknown) {
  const source = createGitHubSource(async () => {
    throw err;
  });
  const out: Activity[] = [];
  for await (const a of source.collect(dayRange("2026-10-16", TZ), { type: "github" }, ctx))
    out.push(a);
  return out;
}

async function fakeGh(script: string) {
  const dir = await mkdtemp(join(tmpdir(), "clockout-gh-"));
  await writeFile(join(dir, "gh"), `#!/bin/sh\n${script}\n`);
  await chmod(join(dir, "gh"), 0o755);
  return dir;
}

describe("GitHub token problems", () => {
  it("says to install gh when it isn't there and no token is set", async () => {
    const empty = await mkdtemp(join(tmpdir(), "clockout-nogh-"));
    const found = await findGitHubToken({ PATH: empty });
    expect(found).toMatchObject({
      problem: expect.stringContaining("isn't installed and no token is set"),
    });
    expect(found).toMatchObject({ problem: expect.stringContaining("https://cli.github.com") });
  });

  it("tells setup to install gh, or to log in, in a few words", async () => {
    const empty = await mkdtemp(join(tmpdir(), "clockout-nogh-"));
    expect((await gitHubStatus({ PATH: empty })).fix).toBe(
      "install gh (https://cli.github.com), then run gh auth login",
    );
    const dir = await fakeGh('echo "no oauth token found for github.com" >&2; exit 1');
    expect(await gitHubStatus({ PATH: dir })).toEqual({ found: null, fix: "run gh auth login" });
  });

  it("says to log in when gh has no login", async () => {
    const dir = await fakeGh('echo "no oauth token found for github.com" >&2; exit 1');
    const found = await findGitHubToken({ PATH: dir });
    expect(found).toMatchObject({
      problem: "GitHub: the GitHub CLI isn't logged in. Run `gh auth login`.",
    });
    expect("cause" in found && found.cause?.message).toContain("no oauth token found");
  });

  it("prefers a token from the environment", async () => {
    expect(await findGitHubToken({ GITHUB_TOKEN: "t", PATH: "/nowhere" })).toEqual({
      token: "t",
      via: "GITHUB_TOKEN",
    });
  });
});

describe("GitHub request failures", () => {
  it("names which token was rejected and how to renew it, never the token", () => {
    const gh = describeGitHubError(httpError(401, "Bad credentials"), "gh", TZ);
    expect(gh.message).toBe(
      "GitHub: your gh login was rejected (expired or revoked). Run `gh auth refresh` (or `gh auth login`).",
    );
    const env = describeGitHubError(httpError(401, "Bad credentials"), "GITHUB_TOKEN", TZ);
    expect(env.message).toContain("the token in GITHUB_TOKEN was rejected");
    expect(env.message).toContain("Put a new token in GITHUB_TOKEN");
    for (const e of [gh, env]) {
      expect(`${e.message} ${(e.cause as Error).message}`).not.toContain("ghp_");
      expect(e.cause).not.toHaveProperty("request");
    }
  });

  it("explains SAML single sign-on", () => {
    const err = graphqlError([
      {
        type: "FORBIDDEN",
        message:
          "Resource protected by organization SAML enforcement. You must grant your Personal Access token access to this organization.",
      },
    ]);
    expect(describeGitHubError(err, "gh", TZ).message).toContain("Run `gh auth refresh`");
    expect(describeGitHubError(err, "GITHUB_TOKEN", TZ).message).toContain(
      "https://github.com/settings/tokens",
    );
  });

  it("names a missing scope and the command that adds it", () => {
    const err = graphqlError([
      {
        type: "INSUFFICIENT_SCOPES",
        message:
          "Your token has not been granted the required scopes to execute this query. The 'login' field requires one of the following scopes: ['read:org'], but your token has only been granted the: ['repo'] scopes.",
      },
    ]);
    expect(describeGitHubError(err, "gh", TZ).message).toBe(
      "GitHub: your gh login is missing a permission Clockout needs (read:org). Run `gh auth refresh -s read:org`.",
    );
  });

  it("says when the rate limit resets, in your time zone", () => {
    const reset = String(Date.UTC(2026, 9, 16, 9, 0) / 1000);
    const err = httpError(403, "API rate limit exceeded", {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": reset,
    });
    expect(describeGitHubError(err, "gh", TZ).message).toBe(
      "GitHub: rate limit reached. It resets at 14:30.",
    );
  });

  it("tells a network problem apart", () => {
    const err = Object.assign(httpError(500, "getaddrinfo ENOTFOUND api.github.com"), {
      cause: new TypeError("fetch failed"),
    });
    expect(describeGitHubError(err, "gh", TZ).message).toBe(
      "GitHub: couldn't reach GitHub. Check your connection and try again.",
    );
  });

  it("explains any other refusal with GitHub's own words", () => {
    const e = describeGitHubError(httpError(403, "Resource not accessible"), "GH_TOKEN", TZ);
    expect(e.message).toContain("GitHub refused the request with the token in GH_TOKEN");
    expect(e.message).toContain("Resource not accessible");
    expect(describeGitHubError(httpError(502, "Bad gateway"), "gh", TZ).message).toBe(
      "GitHub: request failed (HTTP 502). Try again shortly.",
    );
  });

  it("wraps what the source throws", async () => {
    await expect(collectWith(httpError(401, "Bad credentials"))).rejects.toThrow(
      "GitHub: the GitHub token was rejected",
    );
  });

  it("keeps partial GraphQL data when all of it is there", async () => {
    const full = JSON.parse(
      await readFile(
        new URL("../fixtures/github/contributions-2026-10-16.json", import.meta.url),
        "utf8",
      ),
    );
    const out = await collectWith(graphqlError([{ message: "one repo hidden" }], full.data));
    expect(out.length).toBeGreaterThan(0);
    await expect(
      collectWith(graphqlError([{ message: "Something broke" }], { viewer: null })),
    ).rejects.toThrow("GitHub: the contributions query failed: Something broke.");
  });
});
