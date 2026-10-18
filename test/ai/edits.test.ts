import { describe, expect, it } from "vitest";
import { correctionContext, correctionSchema, parseCorrection } from "../../src/ai/edits";
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
