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

  it("asks once for blocks of the same work, so they share one description", async () => {
    const b2 = day.blocks.find((x) => x.id === "b2");
    if (!b2) throw new Error("fixture changed");
    const again = { ...b2, id: "b99", start: new Date(b2.end.getTime() + 3_600_000) };
    const split = { ...day, blocks: [...day.blocks, again] };
    const { b, prompts } = backend((ids) => ids.map((id) => ({ id, summary: `Did ${id}` })));
    const result = await summarizeDay(split, b, {});
    expect((prompts[0] as { id: string }[]).map((x) => x.id)).not.toContain("b99");
    expect(result.get("b99")).toBe("Did b2");
  });

  it("writes in the style you set, with your own words and examples", async () => {
    const systems: string[] = [];
    const long = "Fixed the auth token refresh race and covered it with tests (PR #87). ".repeat(3);
    const b: LlmBackend = {
      id: "fake",
      label: "fake",
      async complete<T>(req: CompleteRequest<T>) {
        systems.push(req.system ?? "");
        const ids = (JSON.parse(req.prompt) as { id: string }[]).map((x) => x.id);
        return req.schema.parse({ summaries: ids.map((id) => ({ id, summary: long })) });
      },
    };
    const style = {
      format: "past" as const,
      length: "long" as const,
      instructions: "Put the ticket key first",
      examples: ["ABC-12 Fixed the login redirect loop"],
    };
    const result = await summarizeDay(day, b, {}, style);
    expect(result.get("b2")).toBe(long.trim().replace(/\.$/, "")); // longer than a short one may be
    expect(systems[0]).toContain("one or two sentences");
    expect(systems[0]).toContain('past-tense verb ("Fixed"');
    expect(systems[0]).toContain("Put the ticket key first");
    expect(systems[0]).toContain("- ABC-12 Fixed the login redirect loop");

    const { b: short } = backend((ids) => ids.map((id) => ({ id, summary: long })));
    await expect(summarizeDay(day, short, {})).rejects.toThrow();
  });

  it("writes cached descriptions again when the style changes, and only then", () => {
    const b2 = day.blocks.find((x) => x.id === "b2");
    if (!b2) throw new Error("fixture changed");
    const plain = blockSignature(b2);
    expect(blockSignature(b2, { format: "imperative", length: "short" })).toBe(plain);
    expect(blockSignature(b2, { format: "past", length: "short" })).not.toBe(plain);
    expect(
      blockSignature(b2, { format: "imperative", length: "short", instructions: "x" }),
    ).not.toBe(plain);
  });
});
