import { describe, expect, it } from "vitest";
import {
  correctionContext,
  correctionSchema,
  localCorrection,
  parseCorrection,
  refuseSecrets,
  settingsContext,
} from "../../src/ai/edits";
import type { CompleteRequest, LlmBackend } from "../../src/ai/types";
import { buildDay } from "../../src/core/blocks";
import { FIXTURE_DATE, fixtureActivities, fixtureConfig } from "../helpers/fixture-day";

const config = fixtureConfig();
const day = buildDay(FIXTURE_DATE, await fixtureActivities(), config);

describe("correctionContext", () => {
  const ctx = correctionContext(day, config, new Date("2026-10-16T13:00:00Z"));

  it("gives the AI ids, local times, gaps and the current time", () => {
    expect(ctx.now).toBe("18:30");
    expect(ctx.blocks[1]).toMatchObject({
      id: "b2",
      start: "10:00",
      end: "12:15",
      minutes: 135,
      confirmed: true,
    });
    expect(ctx.gaps).toEqual([
      { id: "g1", start: "12:15", end: "14:00" },
      { id: "g2", start: "17:00", end: "17:30" },
    ]);
  });

  it("lists PRs with authors so names like Sam's PR resolve", () => {
    expect(ctx.prs).toContainEqual({
      pr: "acme/api#212",
      title: "Rate-limit login attempts",
      author: "sam-example",
    });
  });

  it("offers known projects and tasks", () => {
    expect(ctx.known_projects).toEqual(expect.arrayContaining(["acme/api", "Meetings"]));
    expect(ctx.known_tasks).toEqual(["Development", "Code Review", "Meetings"]);
  });
});

describe("parseCorrection", () => {
  it("sends what the user said with the day, and returns validated ops", async () => {
    let seen = "";
    const backend: LlmBackend = {
      id: "fake",
      label: "fake",
      async complete<T>(req: CompleteRequest<T>) {
        seen = req.prompt;
        return req.schema.parse({
          ops: [{ op: "delete", id: "b4" }],
          reply: "Removed the design sync.",
        });
      },
    };
    const out = await parseCorrection("I skipped the design sync", day, config, backend);
    expect(out.ops).toEqual([{ op: "delete", id: "b4" }]);
    expect(JSON.parse(seen).said).toBe("I skipped the design sync");
    expect(seen).not.toContain("refresh tokens expire early"); // prompt text never leaves the machine
  });

  it("rejects ops with made-up shapes", () => {
    expect(
      correctionSchema.safeParse({ ops: [{ op: "delete", id: "block 4" }], reply: "" }).success,
    ).toBe(false);
  });
});

describe("midnight", () => {
  it("shows a block ending at midnight as 24:00, which edits accept", () => {
    const late = {
      ...day,
      blocks: day.blocks.map((b) =>
        b.id === "b8" ? { ...b, end: new Date("2026-10-16T18:30:00Z") } : b,
      ),
    };
    expect(correctionContext(late, config).blocks.find((b) => b.id === "b8")?.end).toBe("24:00");
  });
});

/** A backend that records what it was sent and answers `out`. */
function recording(out: unknown) {
  const seen: string[] = [];
  const backend: LlmBackend = {
    id: "fake",
    label: "fake",
    async complete<T>(req: CompleteRequest<T>) {
      seen.push(req.prompt);
      return req.schema.parse(out);
    },
  };
  return { backend, seen };
}

describe("settings in the chat", () => {
  const facts = {
    googleConnected: true,
    erpConnected: false,
    claudeProjects: [
      { folder: "-Users-dev-work-acme-api", name: "acme-api", recent: 3 },
      { folder: "-Users-dev-code-personal", name: "personal" },
    ],
  };
  const withFeed = {
    ...config,
    sources: [
      ...config.sources,
      {
        type: "calendar" as const,
        method: "ics" as const,
        url: "https://cal.example.com/private-x/basic.ics",
      },
    ],
    timesheet: {
      type: "next-pms" as const,
      url: "https://erp.example.com",
      map: [{ project: "acme/api", erp_task: "TASK-1", label: "API work" }],
    },
  };

  it("shows the AI names and switches, never folder paths or the calendar link", () => {
    const ctx = settingsContext(withFeed, facts);
    expect(ctx.claude_projects).toEqual([
      { name: "acme-api", on: true, sessions_this_week: 3 },
      { name: "personal", on: true },
    ]);
    expect(ctx.sources).toMatchObject({ calendar_feed: true, google_signed_in: true });
    expect(ctx.erp).toEqual({
      site: "erp.example.com",
      signed_in: false,
      sends: [{ project: "acme/api", to: "API work" }],
    });
    const text = JSON.stringify(ctx);
    expect(text).not.toContain("private-x");
    expect(text).not.toContain("-Users-dev");
  });

  it("sends settings and the last turns along with the day, and returns settings ops", async () => {
    const { backend, seen } = recording({
      ops: [],
      settings: [{ op: "day", target: "7h30m" }],
      reply: "Your target is now 7h 30m.",
    });
    const earlier = [{ said: "what's my target?", reply: "8h." }];
    const out = await parseCorrection("make it seven and a half", day, config, backend, {
      facts,
      earlier,
    });
    expect(out.settings).toEqual([{ op: "day", target: "7h30m" }]);
    const sent = JSON.parse(seen[0] ?? "{}");
    expect(sent.earlier).toEqual(earlier);
    expect(sent.settings.day.target).toBe("8h");
  });

  it("keeps a pasted private calendar link away from the AI", async () => {
    const { backend, seen } = recording({ ops: [], reply: "" });
    const out = await parseCorrection(
      "here's my calendar webcal://cal.example.com/private-a1b2c3d4e5f6a7b8c9d0/basic.ics",
      day,
      config,
      backend,
    );
    expect(seen).toEqual([]);
    expect(out.settings).toEqual([
      {
        op: "calendar_feed",
        url: "https://cal.example.com/private-a1b2c3d4e5f6a7b8c9d0/basic.ics",
      },
    ]);
  });

  it("refuses to send anything that looks like a token", async () => {
    const { backend, seen } = recording({ ops: [], reply: "" });
    for (const said of [
      "my token is ghp_abcdefghijklmnopqrstuvwxyz0123",
      "key 9f8e7d6c5b4a39281706f5e4d3c2b1a0ffee1234",
    ])
      await expect(parseCorrection(said, day, config, backend)).rejects.toThrow(/wasn't sent/);
    expect(seen).toEqual([]);
    // Ordinary words, PR numbers and dashed folder names are fine.
    expect(() => refuseSecrets("reviewed acme/api#212 in -Users-dev-work-acme-api")).not.toThrow();
  });

  it("understands plain connect and disconnect without the AI", () => {
    expect(localCorrection("connect my ERP at erp.example.com")?.settings).toEqual([
      { op: "connect", service: "erp", url: "erp.example.com" },
    ]);
    expect(localCorrection("Connect Google Calendar.")?.settings).toEqual([
      { op: "connect", service: "google" },
    ]);
    expect(localCorrection("disconnect erp")?.settings).toEqual([
      { op: "disconnect", service: "erp" },
    ]);
    expect(localCorrection("connect the standup to the design sync")).toBeNull();
  });
});
