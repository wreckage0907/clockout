import { execa } from "execa";
import type { Detected, SourceContext } from "../types";

export interface GitHubToken {
  token: string;
  via: "GITHUB_TOKEN" | "GH_TOKEN" | "gh";
}

/** Token from the environment, else from the GitHub CLI's login. Never log the result. */
export async function getGitHubToken(env: NodeJS.ProcessEnv): Promise<GitHubToken | null> {
  if (env.GITHUB_TOKEN) return { token: env.GITHUB_TOKEN, via: "GITHUB_TOKEN" };
  if (env.GH_TOKEN) return { token: env.GH_TOKEN, via: "GH_TOKEN" };
  try {
    const { stdout } = await execa("gh", ["auth", "token"], { env, timeout: 5000 });
    const token = stdout.trim();
    return token ? { token, via: "gh" } : null;
  } catch {
    return null;
  }
}

export async function detectGitHub(ctx: Omit<SourceContext, "config">): Promise<Detected | null> {
  const found = await getGitHubToken(ctx.env);
  if (!found) return null;
  return { summary: found.via === "gh" ? "logged in with the gh CLI" : `token from ${found.via}` };
}
