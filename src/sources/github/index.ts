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
              headRefName
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
        issueContributions(first: 100) {
          nodes {
            issue {
              number
              title
              createdAt
              repository { nameWithOwner }
            }
          }
        }
      }
      issueComments(last: 100) {
        nodes {
          createdAt
          issue {
            number
            title
            repository { nameWithOwner }
          }
          pullRequest {
            number
            headRefName
            author { login }
          }
        }
      }
    }
  }
`;

const repo = z.object({ nameWithOwner: z.string() });
const author = z.object({ login: z.string() }).nullable().optional();
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
              headRefName: z.string().optional(),
              author,
              repository: repo,
            }),
            pullRequestReview: z.object({
              submittedAt: z.string().nullable(),
              comments: z.object({ nodes: z.array(z.object({ createdAt: z.string() })) }),
            }),
          }),
        ),
      }),
      issueContributions: z.object({
        nodes: z.array(
          z.object({
            issue: z.object({
              number: z.number(),
              title: z.string(),
              createdAt: z.string(),
              repository: repo,
            }),
          }),
        ),
      }),
    }),
    /** Your latest comments on issues and pull requests (not review comments). */
    issueComments: z.object({
      nodes: z.array(
        z.object({
          createdAt: z.string(),
          issue: z.object({ number: z.number(), title: z.string(), repository: repo }),
          pullRequest: z
            .object({ number: z.number(), headRefName: z.string().optional(), author })
            .nullable()
            .optional(),
        }),
      ),
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
      const { login, contributionsCollection: c, issueComments } = parsed.data.viewer;

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
          ...(pr.headRefName ? { branch: pr.headRefName } : {}),
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

      for (const { issue } of c.issueContributions.nodes) {
        const start = new Date(issue.createdAt);
        if (!inRange(start)) continue;
        yield {
          source: "github",
          kind: "issue",
          actor: "human",
          start,
          title: issue.title,
          repo: issue.repository.nameWithOwner,
          refs: [`issue:${issue.repository.nameWithOwner}#${issue.number}`],
        };
      }

      // A comment on someone else's pull request is part of reviewing it; on your own, part of
      // the work on its branch.
      for (const { createdAt, issue, pullRequest: pr } of issueComments.nodes) {
        const start = new Date(createdAt);
        if (!inRange(start)) continue;
        const name = issue.repository.nameWithOwner;
        const theirs = pr?.author && pr.author.login !== login;
        const a: Activity = {
          source: "github",
          kind: theirs ? "review_comment" : "comment",
          actor: "human",
          start,
          title: issue.title,
          repo: name,
          refs: pr
            ? [`pr:${name}#${pr.number}`, ...(pr.author ? [`author:${pr.author.login}`] : [])]
            : [`issue:${name}#${issue.number}`],
        };
        if (pr?.headRefName) a.branch = pr.headRefName;
        yield a;
      }
    },
  };
}

export const github = createGitHubSource();
