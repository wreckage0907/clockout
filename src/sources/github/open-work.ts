import { graphql as octokitGraphql } from "@octokit/graphql";
import { z } from "zod";
import type { OpenWork } from "../../core/standup";
import { cleanText } from "../../core/text";
import { describeGitHubError } from "./errors";
import type { GraphQLClient } from "./index";
import { findGitHubToken, type GitHubToken } from "./token";

// What's still open on GitHub, for a standup's "today": not activity with times, so not part of
// the source's collect().

export const OPEN_WORK_QUERY = /* GraphQL */ `
  query OpenWork {
    viewer {
      open: pullRequests(states: OPEN, first: 10, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes { number title isDraft headRefName repository { nameWithOwner } }
      }
      finished: pullRequests(
        states: [MERGED, CLOSED]
        first: 50
        orderBy: { field: UPDATED_AT, direction: DESC }
      ) {
        nodes { headRefName repository { nameWithOwner } }
      }
    }
    reviews: search(query: "is:pr is:open archived:false review-requested:@me", type: ISSUE, first: 10) {
      nodes {
        ... on PullRequest { number title author { login } repository { nameWithOwner } }
      }
    }
  }
`;

const repo = z.object({ nameWithOwner: z.string() });
const response = z.object({
  viewer: z.object({
    open: z.object({
      nodes: z.array(
        z.object({
          number: z.number(),
          title: z.string(),
          isDraft: z.boolean().optional(),
          headRefName: z.string().optional(),
          repository: repo,
        }),
      ),
    }),
    finished: z.object({
      nodes: z.array(z.object({ headRefName: z.string().optional(), repository: repo })),
    }),
  }),
  reviews: z.object({
    // Search results that aren't pull requests come back as empty objects.
    nodes: z.array(
      z.union([
        z.object({
          number: z.number(),
          title: z.string(),
          author: z.object({ login: z.string() }).nullable().optional(),
          repository: repo,
        }),
        z.object({}).transform(() => null),
      ]),
    ),
  }),
});

/** Your open pull requests, reviews asked of you, and the branches of recently finished ones. */
export async function openWork(
  env: NodeJS.ProcessEnv,
  timezone: string,
  client?: GraphQLClient,
): Promise<OpenWork> {
  let run = client;
  let via: GitHubToken["via"] | undefined;
  if (!run) {
    const found = await findGitHubToken(env);
    if (!("token" in found)) throw new Error(found.problem, { cause: found.cause });
    via = found.via;
    const url = env.GITHUB_GRAPHQL_URL;
    const gql = octokitGraphql.defaults({
      headers: { authorization: `token ${found.token}` },
      ...(url ? { url } : {}),
    });
    run = (query, variables) => gql(query, variables);
  }
  let raw: unknown;
  try {
    raw = await run(OPEN_WORK_QUERY, {});
  } catch (err) {
    throw describeGitHubError(err, via, timezone);
  }
  const data =
    raw && typeof raw === "object" && "data" in raw ? (raw as { data: unknown }).data : raw;
  const parsed = response.safeParse(data);
  if (!parsed.success)
    throw new Error("GitHub: open pull requests came back in a shape Clockout doesn't know.", {
      cause: new Error(parsed.error.message),
    });
  const { viewer, reviews } = parsed.data;
  const finished: Record<string, string[]> = {};
  for (const n of viewer.finished.nodes) {
    if (!n.headRefName) continue;
    const name = n.repository.nameWithOwner;
    finished[name] = [...(finished[name] ?? []), n.headRefName];
  }
  return {
    prs: viewer.open.nodes.map((p) => ({
      repo: p.repository.nameWithOwner,
      number: p.number,
      title: cleanText(p.title),
      ...(p.isDraft ? { draft: true } : {}),
      ...(p.headRefName ? { branch: p.headRefName } : {}),
    })),
    reviews: reviews.nodes.flatMap((r) =>
      r
        ? [
            {
              repo: r.repository.nameWithOwner,
              number: r.number,
              title: cleanText(r.title),
              ...(r.author ? { author: r.author.login } : {}),
            },
          ]
        : [],
    ),
    finished,
  };
}
