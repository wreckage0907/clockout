import { describe, expect, it } from "vitest";
import { blockSignature, summarizeDay } from "../../src/ai/summarize";
import type { CompleteRequest, LlmBackend } from "../../src/ai/types";
import { buildDay } from "../../src/core/blocks";
import { FIXTURE_DATE, fixtureActivities, fixtureConfig } from "../helpers/fixture-day";

function backend(reply: (ids: string[]) => { id: string; summary: string }[]) {
  const prompts: unknown[] = [];
  const b: LlmBackend = {
    id: "fake",
    label: "fake",
    async complete<T>(req: CompleteRequest<T>) {
      const input = JSON.parse(req.prompt) as { id: string }[];
      prompts.push(input);
      return req.schema.parse({ summaries: reply(input.map((x) => x.id)) });
    },
  };
  return { b, prompts };
}

describe("summarizeDay", async () => {
  const day = buildDay(FIXTURE_DATE, await fixtureActivities(), fixtureConfig());

  it("asks only about work and review blocks, sending titles and PRs but no prompt text", async () => {
    const { b, prompts } = backend((ids) => ids.map((id) => ({ id, summary: `Did ${id}.` })));
    const result = await summarizeDay(day, b, {});
    expect([...result.keys()]).toEqual(["b2", "b3", "b5", "b8"]);
    expect(result.get("b2")).toBe("Did b2"); // trailing period dropped
    expect(prompts[0]).toContainEqual(
      expect.objectContaining({
        id: "b2",
        sessions: ["Fix auth token refresh"],
        openedPrs: ["#87 Fix auth token refresh race"],
        branches: ["fix/auth-refresh"],
      }),
    );
    expect(JSON.stringify(prompts)).not.toContain("refresh tokens expire early"); // a prompt's text
  });

  it("reuses cached summaries and only asks about new blocks", async () => {
    const b2 = day.blocks.find((x) => x.id === "b2");
    if (!b2) throw new Error("fixture changed");
    const cache = { [blockSignature(b2)]: "Cached" };
    const { b, prompts } = backend((ids) => ids.map((id) => ({ id, summary: "New" })));
    const result = await summarizeDay(day, b, cache);
    expect(result.get("b2")).toBe("Cached");
    expect((prompts[0] as { id: string }[]).map((x) => x.id)).toEqual(["b3", "b5", "b8"]);
    expect(Object.keys(cache)).toHaveLength(4);
  });
});
