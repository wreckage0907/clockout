import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SourceLookup } from "./collect";
import { type Config, configSchema } from "./config/schema";
import { getSource } from "./sources";
import { createGitHubSource } from "./sources/github";
import { DayStore } from "./store/json-store";

/** The synthetic day the demo shows: Thu 16 Oct 2026 in Asia/Kolkata. */
export const DEMO_DATE = "2026-10-16";

const DEMO_REPOS: Record<string, string> = {
  "/Users/dev/work/acme-api": "acme/api",
  "/Users/dev/code/clockout": "dev-example/clockout",
};

/** Bundled data: dist/demo/fixtures when installed, test/fixtures when running from source. */
function bundledDir(): string {
  for (const rel of ["./demo/fixtures/", "../test/fixtures/"]) {
    const dir = fileURLToPath(new URL(rel, import.meta.url));
    if (existsSync(join(dir, "claude"))) return dir;
  }
  throw new Error("Demo data is missing from this install.");
}

export interface Demo {
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
 * A self-contained demo: copies the bundled sessions, PR data and calendar to a temp folder
 * (fresh file times, so nothing is skipped as old) and uses a throwaway store. Never touches
 * the user's config or data.
 */
export async function setupDemo(): Promise<Demo> {
  const root = await mkdtemp(join(tmpdir(), "clockout-demo-"));
  const data = join(root, "fixtures");
  await cp(bundledDir(), data, { recursive: true });
  const github = JSON.parse(
    await readFile(join(data, "github", `contributions-${DEMO_DATE}.json`), "utf8"),
  );

  const config = configSchema.parse({
    me: { name: "Demo Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
    projects: [{ name: "Acme API", match: { repo: "acme/api" } }],
    sources: [
      { type: "claude-code", projects_dir: join(data, "claude", "projects") },
      { type: "github" },
      {
        type: "calendar",
        method: "ics",
        url: pathToFileURL(join(data, "ics", "calendar.ics")).href,
      },
    ],
  });
  const demoGitHub = createGitHubSource(async () => github);
  return {
    date: DEMO_DATE,
    config,
    store: new DayStore(join(root, "data")),
    sources: (type) => (type === "github" ? demoGitHub : getSource(type)),
    ctx: { homeDir: root, env: {}, resolveRepo: async (cwd) => DEMO_REPOS[cwd] },
  };
}
