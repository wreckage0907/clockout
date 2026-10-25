import { describe, expect, it } from "vitest";
import { writeStandup } from "../../src/ai/standup";
import type { CompleteRequest, LlmBackend } from "../../src/ai/types";
import { configSchema } from "../../src/config/schema";
import type { StandupFacts } from "../../src/core/standup";

const style = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: "Asia/Kolkata" },
}).standup;

const facts: StandupFacts = {
  date: "2026-10-19",
  yesterday: {
    date: "2026-10-16",
    items: [{ kind: "work", project: "acme/api", description: "Fix auth (PR #87)", hours: 1 }],
  },
  meetings: [{ title: "Design sync", time: "15:00" }],
  prs: [],
  reviews: [],
  branches: [],
  blockers: ["Waiting on the staging database password"],
};

function recording(out: unknown) {
  const seen: CompleteRequest<unknown>[] = [];
  const backend: LlmBackend = {
    id: "fake",
    label: "fake",
    async complete<T>(req: CompleteRequest<T>) {
      seen.push(req as CompleteRequest<unknown>);
      return req.schema.parse(out);
    },
  };
  return { backend, seen };
}

describe("the standup by AI", () => {
  it("sends titles and summaries, never your blockers", async () => {
    const { backend, seen } = recording({
      yesterday: ["Fixed auth (PR #87)"],
      today: ["Design sync"],
    });
    const out = await writeStandup(facts, backend, style);
    expect(out).toEqual({ yesterday: ["Fixed auth (PR #87)"], today: ["Design sync"] });
    expect(seen[0]?.prompt).toContain("Fix auth (PR #87)");
    expect(seen[0]?.prompt).not.toContain("staging database");
    expect(seen[0]?.system).toContain("at most 3 items per section");
  });

  it("follows your style: prose, your prompt and examples", async () => {
    const { backend, seen } = recording({ yesterday: ["Fixed auth."], today: ["Design sync."] });
    await writeStandup(facts, backend, {
      ...style,
      format: "prose",
      instructions: "Mention ticket keys first",
      examples: ["Y: shipped X. T: Y."],
    });
    expect(seen[0]?.system).toContain("a sentence or two in the first person");
    expect(seen[0]?.system).toContain("Mention ticket keys first");
    expect(seen[0]?.system).toContain("Y: shipped X. T: Y.");
  });

  it("refuses more items than the length allows", async () => {
    const { backend } = recording({ yesterday: ["a", "b", "c", "d"], today: [] });
    await expect(writeStandup(facts, backend, style)).rejects.toThrow();
  });

  it("cleans items: no bullets, no escape codes, nothing that looks like a secret", async () => {
    const { backend } = recording({
      yesterday: ["- Fixed\u001b[31m auth", "Rotated ghp_abcdefghijklmnopqrstuvwxyz0123456789"],
      today: ["• Design sync"],
    });
    expect(await writeStandup(facts, backend, style)).toEqual({
      yesterday: ["Fixed auth"],
      today: ["Design sync"],
    });
  });
});
