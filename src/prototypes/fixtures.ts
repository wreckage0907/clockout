import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SourceLookup } from "../collect";
import { type Config, configSchema } from "../config/schema";
import { getSource } from "../sources";
import { createGitHubSource } from "../sources/github";
import { DayStore } from "../store/json-store";

/** The synthetic day the prototypes show: Fri 16 Oct 2026 in Asia/Kolkata. */
export const FIXTURE_DAY = "2026-10-16";

const FIXTURE_REPOS: Record<string, string> = {
  "/Users/dev/work/acme-api": "acme/api",
  "/Users/dev/code/clockout": "dev-example/clockout",
};

export interface FixtureDay {
  date: string;
  config: Config;
  store: DayStore;
  sources: SourceLookup;
  ctx: {
    homeDir: string;
    env: NodeJS.ProcessEnv;
    resolveRepo: (cwd: string) => Promise<string | undefined>;
  };
}

/**
 * The design prototypes run on the synthetic day from `test/fixtures`, copied
 * to a temp folder (fresh file times, so nothing is skipped as old) with a
 * throwaway store. Needs a source checkout; never touches the user's data.
 */
export async function setupFixtureDay(): Promise<FixtureDay> {
  const data = fileURLToPath(new URL("../test/fixtures/", import.meta.url));
  if (!existsSync(join(data, "claude"))) {
    throw new Error("The design prototypes need a source checkout with test/fixtures.");
  }
  const root = await mkdtemp(join(tmpdir(), "clockout-design-"));
  await cp(data, join(root, "fixtures"), { recursive: true });
  const github = JSON.parse(
    await readFile(join(root, "fixtures", "github", `contributions-${FIXTURE_DAY}.json`), "utf8"),
  );

  const config = configSchema.parse({
    me: { name: "Demo Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
    projects: [{ name: "Acme API", match: { repo: "acme/api" } }],
    sources: [
      { type: "claude-code", projects_dir: join(root, "fixtures", "claude", "projects") },
      { type: "github" },
      {
        type: "calendar",
        method: "ics",
        url: pathToFileURL(join(root, "fixtures", "ics", "calendar.ics")).href,
      },
    ],
  });
  const demoGitHub = createGitHubSource(async () => github);
  return {
    date: FIXTURE_DAY,
    config,
    store: new DayStore(join(root, "data")),
    sources: (type) => (type === "github" ? demoGitHub : getSource(type)),
    ctx: { homeDir: root, env: {}, resolveRepo: async (cwd) => FIXTURE_REPOS[cwd] },
  };
}
