import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LlmBackend } from "../src/ai/types";
import type { SourceLookup } from "../src/collect";
import type { OpenWork } from "../src/core/standup";
import { localDate } from "../src/core/time";
import type { Source } from "../src/sources/types";
import { buildStandup } from "../src/standup";
import { DayStore } from "../src/store/json-store";
import { fixtureActivities, fixtureConfig } from "./helpers/fixture-day";

const config = fixtureConfig();
const MONDAY = "2026-10-19";

/** Every source answers from the fixtures, for whichever day it's asked about. */
const sources: SourceLookup = (type) =>
  ({
    id: type,
    name: type,
    detect: async () => null,
    async *collect(range) {
      const date = localDate(new Date(range.from.getTime() + 12 * 3_600_000), "Asia/Kolkata");
      for (const a of await fixtureActivities(date, config)) if (a.source === type) yield a;
    },
  }) satisfies Source;

const open: OpenWork = {
  prs: [{ repo: "acme/api", number: 88, title: "Rate limit login", branch: "fix/auth-refresh" }],
  reviews: [{ repo: "acme/web", number: 92, title: "Dark mode", author: "sam" }],
  finished: {},
};

async function store() {
  return new DayStore(await mkdtemp(join(tmpdir(), "clockout-standup-")));
}

describe("buildStandup", () => {
  it("writes Monday's standup from Friday's day, today's calendar and open work", async () => {
    let asked = 0;
    const s = await buildStandup(MONDAY, MONDAY, config, await store(), {
      sources,
      blockers: ["Waiting on API keys"],
      openWork: async () => {
        asked++;
        return open;
      },
    });
    expect(asked).toBe(1);
    expect(s.warnings).toEqual([]);
    expect(s.byAi).toBe(false);
    expect(s.facts.yesterday?.date).toBe("2026-10-16");
    expect(s.facts.yesterday?.items.length).toBeGreaterThan(2);
    expect(s.facts.branches).toEqual([{ repo: "dev-example/clockout", branch: "feat/export" }]);
    const [friday = "", today = "", blockers = ""] = s.text.split("\n\n");
    expect(friday.split("\n")[0]).toBe("Friday");
    expect(friday).toContain("Fix auth token refresh");
    expect(today).toContain("Follow up on PR #88 Rate limit login (acme/api)");
    expect(today).toContain("Continue feat/export (dev-example/clockout)");
    expect(today).toContain("Review PR #92 Dark mode (acme/web, sam)");
    expect(blockers).toBe("Blockers\n- Waiting on API keys");
  });

  it("reads open work only for today's standup", async () => {
    let asked = 0;
    const s = await buildStandup(MONDAY, "2026-10-20", config, await store(), {
      sources,
      openWork: async () => {
        asked++;
        return open;
      },
    });
    expect(asked).toBe(0);
    expect(s.facts.prs).toEqual([]);
  });

  it("still writes it when GitHub or the AI helper fails, saying what went wrong", async () => {
    const broken: LlmBackend = {
      id: "fake",
      label: "fake",
      complete: async () => {
        throw new Error("The AI helper timed out.");
      },
    };
    const s = await buildStandup(MONDAY, MONDAY, config, await store(), {
      sources,
      ai: null,
      openWork: async () => {
        throw new Error("GitHub: the token was rejected.");
      },
    });
    expect(s.warnings).toEqual(["GitHub: the token was rejected."]);
    expect(s.text).toContain("Blockers\n- None");

    const withAi = await buildStandup(MONDAY, MONDAY, config, await store(), {
      sources,
      ai: broken,
      openWork: async () => open,
    });
    expect(withAi.byAi).toBe(false);
    expect(withAi.warnings.at(-1)).toBe(
      "The AI helper timed out. Using the plain standup instead.",
    );
  });

  it("uses the AI's sections when it answers", async () => {
    const ai: LlmBackend = {
      id: "fake",
      label: "fake",
      complete: async <T>(req: { schema: { parse(v: unknown): T }; system: string }) =>
        req.system.includes("standup")
          ? req.schema.parse({ yesterday: ["Fixed auth"], today: ["Rate limiting"] })
          : req.schema.parse({ summaries: [] }),
    };
    const s = await buildStandup(MONDAY, MONDAY, config, await store(), {
      sources,
      ai,
      openWork: async () => open,
    });
    expect(s.byAi).toBe(true);
    expect(s.text).toBe("Friday\n- Fixed auth\n\nToday\n- Rate limiting\n\nBlockers\n- None");
  });
});
