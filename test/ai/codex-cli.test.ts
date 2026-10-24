import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { Runner } from "../../src/ai/cli";
import { codexCliBackend, codexError } from "../../src/ai/codex-cli";

const schema = z.object({ summary: z.string(), note: z.string().optional() });
const req = { system: "Write timesheet descriptions.", prompt: '{"id":"b1"}', schema };

/** A fake `codex exec` that writes `answer` where --output-last-message points. */
function fakeCodex(answers: (string | { stderr: string; exitCode: number })[]) {
  const calls: { args: string[]; input: string; schema: unknown }[] = [];
  const run: Runner = async (_cmd, args, { input }) => {
    const at = (flag: string) => args[args.indexOf(flag) + 1] ?? "";
    calls.push({ args, input, schema: JSON.parse(await readFile(at("--output-schema"), "utf8")) });
    const next = answers.shift() ?? "";
    if (typeof next !== "string") return { stdout: "", ...next };
    await writeFile(at("--output-last-message"), next);
    return { stdout: next, stderr: "", exitCode: 0 };
  };
  return { run, calls };
}

describe("codex CLI backend", () => {
  it("runs codex exec read-only, ephemeral, without the user's config, instructions first", async () => {
    const { run, calls } = fakeCodex(['{"summary":"Fix auth","note":null}']);
    expect(await codexCliBackend(undefined, run).complete(req)).toEqual({ summary: "Fix auth" });
    const { args, input } = calls[0] ?? { args: [] as string[], input: "" };
    expect(args[0]).toBe("exec");
    expect(args).toEqual(
      expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--skip-git-repo-check"]),
    );
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args[args.indexOf("--cd") + 1]).toMatch(/clockout-ai-.*work$/);
    expect(args).not.toContain("--model");
    expect(input).toBe(
      '<instructions>\nWrite timesheet descriptions.\n</instructions>\n\n{"id":"b1"}',
    );
  });

  it("sends the schema in OpenAI's strict form: every key required, optional ones nullable", async () => {
    const { run, calls } = fakeCodex(['{"summary":"x","note":null}']);
    await codexCliBackend("gpt-5", run).complete(req);
    expect(calls[0]?.schema).toEqual({
      type: "object",
      properties: { summary: { type: "string" }, note: { type: ["string", "null"] } },
      required: ["summary", "note"],
      additionalProperties: false,
    });
    expect(calls[0]?.args[calls[0].args.indexOf("--model") + 1]).toBe("gpt-5");
  });

  it("explains a failed sign-in from Codex's ERROR line", async () => {
    const stderr = `OpenAI Codex v0.155.0\nERROR: ${JSON.stringify({ error: { message: "Your access token could not be refreshed" } })}\n`;
    const { run } = fakeCodex([{ stderr, exitCode: 1 }]);
    await expect(codexCliBackend(undefined, run).complete(req)).rejects.toThrow(
      "Codex: Your access token could not be refreshed.",
    );
  });

  it("reads Codex's error lines", () => {
    expect(codexError("a\nERROR: plain words\n")).toBe("plain words");
    expect(codexError("no error lines\nlast one")).toBe("last one");
  });
});
