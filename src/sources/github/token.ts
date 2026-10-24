import { execa } from "execa";
import type { Detected, SourceContext } from "../types";

export interface GitHubToken {
  token: string;
  via: "GITHUB_TOKEN" | "GH_TOKEN" | "gh";
}

/** Why there's no token, and how to get one. */
export interface NoGitHubToken {
  problem: string;
  /** What `gh` said, without any token. */
  cause?: Error;
}

/** Token from the environment, else from the GitHub CLI's login. Never log the result. */
export async function findGitHubToken(
  env: NodeJS.ProcessEnv,
): Promise<GitHubToken | NoGitHubToken> {
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, via: "GITHUB_TOKEN" };
  if (env.GH_TOKEN) return { token: env.GH_TOKEN, via: "GH_TOKEN" };
  try {
    const { stdout } = await execa("gh", ["auth", "token"], { env, timeout: 5000 });
    const token = stdout.trim();
    if (token) return { token, via: "gh" };
    return { problem: "GitHub: the GitHub CLI isn't logged in. Run `gh auth login`." };
  } catch (err) {
    const e = (err && typeof err === "object" ? err : {}) as {
      code?: unknown;
      timedOut?: unknown;
      stderr?: unknown;
    };
    if (e.code === "ENOENT")
      return {
        problem:
          "GitHub: the GitHub CLI isn't installed and no token is set. Install gh (https://cli.github.com) and run `gh auth login`, or set GITHUB_TOKEN.",
        cause: new Error("gh: command not found"),
      };
    const said = typeof e.stderr === "string" ? (e.stderr.trim().split("\n")[0] ?? "") : "";
    const cause = new Error(`gh auth token: ${said || "failed"}`);
    if (e.timedOut === true)
      return {
        problem: "GitHub: the GitHub CLI didn't answer in time. Run `gh auth status` to check it.",
        cause,
      };
    return { problem: "GitHub: the GitHub CLI isn't logged in. Run `gh auth login`.", cause };
  }
}

export async function getGitHubToken(env: NodeJS.ProcessEnv): Promise<GitHubToken | null> {
  const found = await findGitHubToken(env);
  return "token" in found ? found : null;
}

export async function detectGitHub(ctx: Omit<SourceContext, "config">): Promise<Detected | null> {
  const found = await getGitHubToken(ctx.env);
  if (!found) return null;
  return { summary: found.via === "gh" ? "logged in with the gh CLI" : `token from ${found.via}` };
}
