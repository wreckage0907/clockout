import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DATE,
  fakeServer,
  fixtureJson,
  fixtureSourcesToml,
  type Sandbox,
  sandbox,
} from "./helpers";

// One day from start to finish through the built CLI: every local source and the calendar from
// the fixtures, GitHub from a fake server, no AI. The day is drafted, saved, and exported from
// what was saved.

interface Row {
  date: string;
  project: string;
  task: string;
  hours: number;
  description: string;
}
interface DayJson {
  date: string;
  timezone: string;
  blocks: { id: string; project: string; task: string; kind: string; confirmed: boolean }[];
  questions: { text: string }[];
  rows: Row[];
}

let sb: Sandbox;
let github: Awaited<ReturnType<typeof fakeServer>>;
let env: Record<string, string>;

beforeAll(async () => {
  sb = await sandbox();
  const contributions = await fixtureJson("github/contributions-2026-10-16.json");
  github = await fakeServer(() => ({ json: contributions }));
  env = { GITHUB_TOKEN: "test-token", GITHUB_GRAPHQL_URL: `${github.origin}/graphql` };
  await sb.writeConfig(await fixtureSourcesToml(sb, '\n[[sources]]\ntype = "github"\n'));
});
afterAll(() => github.close());

const day = async () => {
  const r = await sb.run(["day", DATE, "--json", "--no-ai"], { env });
  return { ...r, json: JSON.parse(r.stdout) as DayJson };
};

describe("drafting a day", () => {
  it("builds it from every source and prints it as JSON, with nothing on stderr", async () => {
    const { code, stderr, json } = await day();
    expect(stderr).toBe("");
    expect(code).toBe(0);
    expect(json.date).toBe(DATE);
    expect(json.timezone).toBe("Asia/Kolkata");
    expect(json.rows).toEqual([
      row("Meetings", "Meetings", 0.5, "Daily standup"),
      row("acme/api", "Development", 1.25, "Fix auth token refresh"),
      row("acme/api", "Development", 0.25, "Rate limit the login endpoint"),
      row("acme/api", "Development", 0.75, "Fix auth token refresh (PR #87)"),
      row("acme/api", "Development", 0.5, "Fix rate limit"),
      row("acme/api", "Development", 0.25, "Paginate the invoices endpoint"),
      row("dev-example/clockout", "Development", 2.5, "Build export command (PR #48)"),
      row("acme/api", "Code Review", 0.5, "Review Rate-limit login attempts (PR #212)"),
      row("acme/api", "Development", 0.25, "Investigate flaky deploy"),
      row("dev-example/clockout", "Development", 0.25, "Work on dev-example/clockout"),
    ]);
    // Meetings you haven't answered are blocks, but not rows.
    const unconfirmed = json.blocks.filter((b) => !b.confirmed).map((b) => b.kind);
    expect(unconfirmed).toEqual(["meeting", "meeting", "meeting"]);
    expect(json.questions).toHaveLength(5);
  });

  it("asks GitHub for the day in your time zone, with your token", async () => {
    const req = github.requests.at(-1);
    expect(req?.path).toBe("/graphql");
    expect(req?.headers.authorization).toBe("token test-token");
    expect(JSON.parse(req?.body ?? "{}").variables).toEqual({
      from: "2026-10-15T18:30:00.000Z",
      to: "2026-10-16T18:30:00.000Z",
    });
  });

  it("saves the day, readable only by you, and shows the same day again", async () => {
    const file = join(sb.data, "days", `${DATE}.json`);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(file, "utf8")) as {
      version: number;
      day: { blocks: { id: string }[] };
      edits: unknown[];
    };
    expect(saved.version).toBe(1);
    expect(saved.edits).toEqual([]);
    const again = await day();
    expect(saved.day.blocks.map((b) => b.id)).toEqual(again.json.blocks.map((b) => b.id));
    expect(again.stdout).toBe((await day()).stdout);
  });

  it("drafts the day from the other sources when one fails, and says which", async () => {
    const r = await sb.run(["day", DATE, "--json", "--no-ai", "--refresh"], {
      env: { ...env, GITHUB_TOKEN: "", GITHUB_GRAPHQL_URL: "", PATH: sb.env.PATH ?? "" },
    });
    expect(r.code).toBe(0);
    expect(r.stderr).toMatch(/^warning: GitHub: the GitHub CLI isn't installed/);
    expect((JSON.parse(r.stdout) as DayJson).rows.length).toBeGreaterThan(5);
  });
});

describe("exporting the saved day", () => {
  it("writes the same rows as CSV, Markdown, TSV and JSON", async () => {
    const { json } = await day();
    const csv = await sb.run(["export", DATE, "--no-ai"], { env });
    expect(csv.code).toBe(0);
    const lines = csv.stdout.trimEnd().split("\r\n");
    expect(lines[0]).toBe("date,project,task,hours,description");
    expect(lines).toHaveLength(json.rows.length + 1);
    expect(lines[1]).toBe("2026-10-16,Meetings,Meetings,0.50,Daily standup");

    const asJson = await sb.run(["export", DATE, "-f", "JSON", "--no-ai"], { env });
    expect(JSON.parse(asJson.stdout)).toEqual(json.rows);

    const md = await sb.run(["export", DATE, "-f", "md", "--no-ai"], { env });
    expect(md.stdout.trimEnd().split("\n").at(-1)).toBe("| | | **Total** | **7.00** | |");

    const tsv = await sb.run(["export", DATE, "-f", "tsv", "--no-ai"], { env });
    expect(tsv.stdout.trimEnd().split("\n")[1]).toBe(
      "2026-10-16\tacme/api\tDevelopment\t1.25\tFix auth token refresh",
    );
  });

  it("writes a file and says so on stderr, keeping stdout clean", async () => {
    const out = join(sb.home, "day.csv");
    const r = await sb.run(["export", DATE, "-o", out, "--no-ai"], { env });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr.split("\n")[0]).toBe(`Wrote 10 rows to ${out}.`);
    expect(r.stderr).toContain("5 open questions; unconfirmed meetings aren't included.");
    expect(await readFile(out, "utf8")).toBe(
      (await sb.run(["export", DATE, "--no-ai"], { env })).stdout,
    );
  });

  it("exports a range, one day after another", async () => {
    const r = await sb.run(["export", "--from", "2026-10-15", "--to", DATE, "-f", "json"], {
      env,
    });
    expect(r.code).toBe(0);
    const rows = JSON.parse(r.stdout) as Row[];
    expect(new Set(rows.map((x) => x.date))).toEqual(new Set(["2026-10-15", DATE]));
    expect(rows.filter((x) => x.date === DATE)).toHaveLength(10);
  });
});

describe("without an AI helper", () => {
  it("explains that typed corrections need one, and changes nothing", async () => {
    const before = await readFile(join(sb.data, "days", `${DATE}.json`), "utf8");
    const r = await sb.run(["edit", "-d", DATE, "the standup ran to 45 minutes"], { env });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/^clockout: Typed corrections need the AI helper, and it's off/);
    expect(await readFile(join(sb.data, "days", `${DATE}.json`), "utf8")).toBe(before);
  });

  it("has nothing to undo on a day without corrections", async () => {
    const r = await sb.run(["undo", "-d", DATE], { env });
    expect(r).toEqual({ code: 0, stdout: `Nothing to undo for ${DATE}.\n`, stderr: "" });
  });
});

function row(project: string, task: string, hours: number, description: string): Row {
  return { date: DATE, project, task, hours, description };
}
