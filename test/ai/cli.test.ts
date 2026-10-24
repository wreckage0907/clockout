import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  cliFailure,
  cliRunner,
  jsonIn,
  lastLine,
  runCli,
  strictSchema,
  withoutNulls,
} from "../../src/ai/cli";

describe("agent CLI helpers", () => {
  it("makes a schema strict: anyOf for oneOf, every key required, optional ones nullable", () => {
    const strict = strictSchema({
      type: "object",
      properties: {
        ops: {
          type: "array",
          items: {
            oneOf: [
              {
                type: "object",
                properties: { op: { type: "string", const: "add" }, at: { type: "string" } },
                required: ["op"],
              },
            ],
          },
        },
        kind: { type: "string", enum: ["a", "b"] },
      },
      required: ["ops"],
    });
    expect(strict).toEqual({
      type: "object",
      properties: {
        ops: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  op: { type: "string", const: "add" },
                  at: { type: ["string", "null"] },
                },
                required: ["op", "at"],
                additionalProperties: false,
              },
            ],
          },
        },
        kind: { anyOf: [{ type: "string", enum: ["a", "b"] }, { type: "null" }] },
      },
      required: ["ops", "kind"],
      additionalProperties: false,
    });
  });

  it("turns nulls back into absent keys", () => {
    expect(withoutNulls({ a: 1, b: null, c: [{ d: null, e: "x" }] })).toEqual({
      a: 1,
      c: [{ e: "x" }],
    });
  });

  it("finds the JSON in a chatty reply", () => {
    expect(jsonIn('{"a":1}')).toEqual({ a: 1 });
    expect(jsonIn('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(jsonIn('Sure, here it is: {"a":{"b":2}} Hope that helps')).toEqual({ a: { b: 2 } });
    expect(jsonIn("no json here")).toBeUndefined();
  });

  it("keeps the last useful line, without terminal colours", () => {
    expect(lastLine("first\n\u001b[31mreal problem\u001b[0m\n\n")).toBe("real problem");
  });

  it("adds how to sign in only when the failure is about signing in", () => {
    expect(cliFailure("Codex", "Not logged in", "run `codex login`.").message).toBe(
      "Codex: Not logged in. Not signed in, or the sign-in expired: run `codex login`.",
    );
    expect(cliFailure("Codex", "model overloaded", "run `codex login`.").message).toBe(
      "Codex: model overloaded.",
    );
  });

  it("on a timeout, stops the helper and anything it started, even if they hold the output open", async () => {
    // A shell that starts a long sleep sharing its output, as agent CLIs start tools.
    const started = Date.now();
    const run = cliRunner(300);
    await expect(
      run("sh", ["-c", "sleep 30 & echo started; wait"], { input: "", cwd: tmpdir() }),
    ).rejects.toThrow("didn't answer within 1 second");
    expect(Date.now() - started).toBeLessThan(5000);
  });

  it("says when the helper isn't installed", async () => {
    await expect(
      runCli("clockout-no-such-helper", [], { input: "", cwd: tmpdir() }),
    ).rejects.toThrow("isn't installed");
  });
});
