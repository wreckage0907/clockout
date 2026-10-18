import { graphql as octokitGraphql } from "@octokit/graphql";
import { z } from "zod";
import type { Activity } from "../../core/types";
import type { Source } from "../types";
import { detectGitHub, getGitHubToken } from "./token";

export interface GitHubConfig {
  type: "github";
}

export type GraphQLClient = (query: string, variables: Record<string, unknown>) => Promise<unknown>;

export const CONTRIBUTIONS_QUERY = /* GraphQL */ `
  query Contributions($from: DateTime!, $to: DateTime!) {
    viewer {
      login
      contributionsCollection(from: $from, to: $to) {
        pullRequestContributions(first: 100) {
          nodes {
            occurredAt
            pullRequest {
              number
              title
              url
              createdAt
              headRefName
              repository { nameWithOwner }
            }
          }
        }
        pullRequestReviewContributions(first: 100) {
          nodes {
            occurredAt
            pullRequest {
              number
              title
              url
              author { login }
              repository { nameWithOwner }
            }
            pullRequestReview {
              state
              submittedAt
              url
              comments(first: 100) { nodes { createdAt } }
            }
          }
        }
      }
    }
  }
`;

const repo = z.object({ nameWithOwner: z.string() });
const response = z.object({
  viewer: z.object({
    login: z.string(),
    contributionsCollection: z.object({
      pullRequestContributions: z.object({
        nodes: z.array(
          z.object({
            pullRequest: z.object({
              number: z.number(),
              title: z.string(),
              createdAt: z.string(),
              headRefName: z.string().optional(),
              repository: repo,
            }),
          }),
        ),
      }),
      pullRequestReviewContributions: z.object({
        nodes: z.array(
          z.object({
            pullRequest: z.object({
              number: z.number(),
              title: z.string(),
              author: z.object({ login: z.string() }).nullable().optional(),
              repository: repo,
            }),
            pullRequestReview: z.object({
              submittedAt: z.string().nullable(),
              comments: z.object({ nodes: z.array(z.object({ createdAt: z.string() })) }),
            }),
          }),
        ),
      }),
    }),
  }),
});

/** GitHub GraphQL responses arrive either bare (`viewer`) or wrapped in `data`. */
function unwrap(raw: unknown): unknown {
  return raw && typeof raw === "object" && "data" in raw ? (raw as { data: unknown }).data : raw;
}

export function createGitHubSource(client?: GraphQLClient): Source<GitHubConfig> {
  return {
    id: "github",
    name: "GitHub",
    detect: detectGitHub,
    async *collect(range, _cfg, ctx) {
      let run = client;
      if (!run) {
        const found = await getGitHubToken(ctx.env);
        if (!found)
          throw new Error("GitHub: not logged in. Run `gh auth login` or set GITHUB_TOKEN.");
        const gql = octokitGraphql.defaults({ headers: { authorization: `token ${found.token}` } });
        run = (query, variables) => gql(query, variables);
      }
      const raw = await run(CONTRIBUTIONS_QUERY, {
        from: range.from.toISOString(),
        to: range.to.toISOString(),
      });
      const parsed = response.safeParse(unwrap(raw));
      if (!parsed.success)
        throw new Error("GitHub: unexpected response from the contributions API");

      const inRange = (d: Date) => d >= range.from && d < range.to;
      const c = parsed.data.viewer.contributionsCollection;

      for (const { pullRequest: pr } of c.pullRequestContributions.nodes) {
        const start = new Date(pr.createdAt);
        if (!inRange(start)) continue;
        const a: Activity = {
          source: "github",
          kind: "pr",
          actor: "human",
          start,
          title: pr.title,
          repo: pr.repository.nameWithOwner,
          refs: [`pr:${pr.repository.nameWithOwner}#${pr.number}`],
        };
        if (pr.headRefName) a.branch = pr.headRefName;
        yield a;
      }

      for (const { pullRequest: pr, pullRequestReview: review } of c.pullRequestReviewContributions
        .nodes) {
        const common = {
          source: "github",
          actor: "human" as const,
          title: pr.title,
          repo: pr.repository.nameWithOwner,
          refs: [
            `pr:${pr.repository.nameWithOwner}#${pr.number}`,
            ...(pr.author ? [`author:${pr.author.login}`] : []),
          ],
        };
        for (const comment of review.comments.nodes) {
          const start = new Date(comment.createdAt);
          if (inRange(start)) yield { ...common, kind: "review_comment", start };
        }
        if (review.submittedAt) {
          const start = new Date(review.submittedAt);
          if (inRange(start)) yield { ...common, kind: "review", start };
        }
      }
    },
  };
}

export const github = createGitHubSource();
