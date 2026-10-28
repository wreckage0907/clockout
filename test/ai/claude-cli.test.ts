import { readFile, stat } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { claudeCliBackend } from "../../src/ai/claude-cli";
import type { Runner } from "../../src/ai/cli";
import { fakeCli as fake } from "../helpers/fake-cli";

const schema = z.object({ summary: z.string() });
const req = { system: "sys", prompt: "hello", schema };

const ok = (value: unknown) =>
  JSON.stringify({ type: "result", is_error: false, structured_output: value });

describe("claude CLI backend", () => {
  it("runs claude -p with tools, MCP, settings and session saving off, prompt on stdin", async () => {
    const { run, calls } = fake([ok({ summary: "Fix auth" })]);
    expect(await claudeCliBackend("haiku", run).complete(req)).toEqual({ summary: "Fix auth" });
    const { cmd, args, input, cwd } = calls[0] ?? { cmd: "", args: [], input: "", cwd: "" };
    expect(cmd).toBe("claude");
    expect(input).toBe("hello");
    expect(cwd).toMatch(/clockout-ai-/);
    expect(args).toEqual(
      expect.arrayContaining(["-p", "--no-session-persistence", "--strict-mcp-config"]),
    );
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args[args.indexOf("--model") + 1]).toBe("haiku");
    expect(args).not.toContain("--system-prompt");
    expect(args).not.toContain("sys");
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1] ?? "")).not.toHaveProperty("$schema");
  });

  it("puts the system prompt in a private file, not on the command line", async () => {
    let file = "";
    let content = "";
    let mode = 0;
    const run: Runner = async (_cmd, args) => {
      file = args[args.indexOf("--system-prompt-file") + 1] ?? "";
      content = await readFile(file, "utf8");
      mode = (await stat(file)).mode & 0o777;
      return { stdout: ok({ summary: "x" }), stderr: "", exitCode: 0 };
    };
    await claudeCliBackend("haiku", run).complete({ ...req, system: "Notes: ship Friday" });
    expect(file).toMatch(/clockout-ai-.*system-prompt\.txt$/);
    expect(content).toBe("Notes: ship Friday");
    expect(mode).toBe(0o600);
    await expect(stat(file)).rejects.toThrow(); // gone with the temp folder
  });

  it("retries once when the output doesn't match", async () => {
    const { run, calls } = fake([ok({ wrong: 1 }), ok({ summary: "Second try" })]);
    expect(await claudeCliBackend("haiku", run).complete(req)).toEqual({ summary: "Second try" });
    expect(calls).toHaveLength(2);
  });

  it("says what Claude said when logged out, and how to sign in, without the command line", async () => {
    const out = JSON.stringify({
      type: "result",
      is_error: true,
      result: "Invalid API key · Please run /login",
    });
    const err = await claudeCliBackend("haiku", fake([{ stdout: out, exitCode: 1 }]).run)
      .complete(req)
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe(
      "Claude Code: Invalid API key · Please run /login. Not signed in, or the sign-in expired: run `claude` and type /login.",
    );
    expect((err as Error).message).not.toMatch(/--json-schema|sys/);
  });

  it("falls back to the last line of stderr when there's no envelope", async () => {
    const { run } = fake([{ stderr: "boot\nSomething broke\n", exitCode: 2 }]);
    await expect(claudeCliBackend("haiku", run).complete(req)).rejects.toThrow(
      "Claude Code: Something broke.",
    );
  });

  it("says when it couldn't be started", async () => {
    const run: Runner = async () => {
      throw new Error("didn't answer within 2 minutes");
    };
    await expect(claudeCliBackend("haiku", run).complete(req)).rejects.toThrow(
      "Claude Code didn't answer within 2 minutes.",
    );
  });
});
