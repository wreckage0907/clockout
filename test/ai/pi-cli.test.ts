import { describe, expect, it } from "vitest";
import { z } from "zod";
import { piCliBackend } from "../../src/ai/pi-cli";
import { fakeCli } from "../helpers/fake-cli";

const schema = z.object({ summary: z.string() });
const req = { system: "Write timesheet descriptions.", prompt: "hello", schema };

describe("pi CLI backend", () => {
  it("runs pi -p with tools, extensions and saving off; the schema is in the system prompt", async () => {
    const { run, calls } = fakeCli(['```json\n{"summary":"Fix auth"}\n```']);
    expect(await piCliBackend(undefined, run).complete(req)).toEqual({ summary: "Fix auth" });
    const { cmd, args, input } = calls[0] ?? { cmd: "", args: [] as string[], input: "" };
    expect(cmd).toBe("pi");
    expect(input).toBe("hello");
    expect(args).toEqual(
      expect.arrayContaining(["-p", "--no-session", "--no-tools", "--no-extensions", "--no-mcp"]),
    );
    const system = args[args.indexOf("--system-prompt") + 1] ?? "";
    expect(system).toMatch(/^Write timesheet descriptions\./);
    expect(system).toContain('"required":["summary"]');
  });

  it("asks again when the reply isn't JSON of the right shape", async () => {
    const { run, calls } = fakeCli(["Sure! Here you go.", 'Here: {"summary":"Second"}']);
    expect(await piCliBackend("openai/gpt-5", run).complete(req)).toEqual({ summary: "Second" });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.args).toEqual(expect.arrayContaining(["--model", "openai/gpt-5"]));
  });

  it("explains a missing sign-in", async () => {
    const { run } = fakeCli([{ stderr: "No API key found for anthropic", exitCode: 1 }]);
    await expect(piCliBackend(undefined, run).complete(req)).rejects.toThrow(
      "Pi: No API key found for anthropic. Not signed in, or the sign-in expired: run `pi` and sign in to a provider (/login).",
    );
  });
});
