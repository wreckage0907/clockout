import { describe, expect, it } from "vitest";
import { z } from "zod";
import { claudeCliBackend, jsonSchema, type Runner } from "../../src/ai/claude-cli";

const schema = z.object({ summary: z.string() });
const req = { system: "sys", prompt: "hello", schema };

function fake(outputs: string[]) {
  const calls: { args: string[]; input: string; cwd: string }[] = [];
  const run: Runner = async (args, input, cwd) => {
    calls.push({ args, input, cwd });
    const next = outputs.shift();
    if (next === undefined) throw new Error("no more outputs");
    return next;
  };
  return { run, calls };
}

const ok = (value: unknown) =>
  JSON.stringify({ type: "result", is_error: false, structured_output: value });

describe("claude CLI backend", () => {
  it("runs claude -p with tools, MCP, settings and session saving off, prompt on stdin", async () => {
    const { run, calls } = fake([ok({ summary: "Fix auth" })]);
    expect(await claudeCliBackend("haiku", run).complete(req)).toEqual({ summary: "Fix auth" });
    const { args, input, cwd } = calls[0] ?? { args: [], input: "", cwd: "" };
    expect(input).toBe("hello");
    expect(cwd).toMatch(/clockout-ai-/);
    expect(args).toEqual(
      expect.arrayContaining(["-p", "--no-session-persistence", "--strict-mcp-config"]),
    );
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("sys");
  });

  it("sends a JSON schema without the $schema marker", () => {
    expect(JSON.parse(jsonSchema(schema))).toEqual({
      type: "object",
      properties: { summary: { type: "string" } },
      required: ["summary"],
      additionalProperties: false,
    });
  });

  it("retries once when the output doesn't match", async () => {
    const { run, calls } = fake([ok({ wrong: 1 }), ok({ summary: "Second try" })]);
    expect(await claudeCliBackend("haiku", run).complete(req)).toEqual({ summary: "Second try" });
    expect(calls).toHaveLength(2);
  });

  it("explains failures", async () => {
    const err = JSON.stringify({ type: "result", is_error: true, result: "Not logged in" });
    await expect(claudeCliBackend("haiku", fake([err, err]).run).complete(req)).rejects.toThrow(
      "Claude Code: Not logged in",
    );
  });
});
