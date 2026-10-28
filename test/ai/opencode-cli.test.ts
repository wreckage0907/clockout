import { describe, expect, it } from "vitest";
import { z } from "zod";
import { opencodeCliBackend } from "../../src/ai/opencode-cli";
import { fakeCli } from "../helpers/fake-cli";

const schema = z.object({ summary: z.string() });
const req = { system: "Write timesheet descriptions.", prompt: "hello", schema };
const line = (o: unknown) => JSON.stringify(o);
const session = "ses_0a1b2c3d4ffeClockoutAi05";

describe("opencode CLI backend", () => {
  it("runs a private opencode as an agent with every tool denied, then deletes the session", async () => {
    const out = [
      line({ type: "step_start", sessionID: session, part: {} }),
      line({ type: "text", sessionID: session, part: { text: '{"summary":"Fix auth"}' } }),
    ].join("\n");
    const { run, calls } = fakeCli([out, "Session deleted"]);
    expect(await opencodeCliBackend(undefined, run).complete(req)).toEqual({
      summary: "Fix auth",
    });
    const [ask, del] = calls;
    expect(ask?.args).toEqual(["run", "--standalone", "--format", "json", "--agent", "clockout"]);
    expect(ask?.input).toBe("hello");
    const config = JSON.parse(ask?.env?.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(config.agent.clockout.permission).toEqual({ "*": "deny" });
    expect(config.agent.clockout.prompt).toMatch(/^Write timesheet descriptions\./);
    // An empty config folder in the call's temp dir, so the user's own MCP servers and plugins stay
    // out; the data folder (sign-in) isn't moved.
    expect(ask?.env?.XDG_CONFIG_HOME).toMatch(/clockout-ai-[^/]+\/config$/);
    expect(ask?.env).not.toHaveProperty("XDG_DATA_HOME");
    expect(del?.env?.XDG_CONFIG_HOME).toBe(ask?.env?.XDG_CONFIG_HOME);
    expect(del?.args).toEqual(["session", "delete", session, "--standalone"]);
  });

  it("sets a model on the agent, not with --model (which drops the agent's prompt)", async () => {
    const out = line({ type: "text", sessionID: session, part: { text: '{"summary":"x"}' } });
    const { run, calls } = fakeCli([out, ""]);
    await opencodeCliBackend("anthropic/claude-haiku-5-5", run).complete(req);
    expect(calls[0]?.args).not.toContain("--model");
    const config = JSON.parse(calls[0]?.env?.OPENCODE_CONFIG_CONTENT ?? "{}");
    expect(config.agent.clockout.model).toBe("anthropic/claude-haiku-5-5");
  });

  it("explains opencode's own errors, and still deletes the session", async () => {
    const out = line({
      type: "error",
      sessionID: session,
      error: { message: "Unauthorized: invalid credentials for provider" },
    });
    const { run, calls } = fakeCli([out, ""]);
    await expect(opencodeCliBackend(undefined, run).complete(req)).rejects.toThrow(
      "opencode: Unauthorized: invalid credentials for provider. Not signed in, or the sign-in expired: run `opencode auth login`.",
    );
    expect(calls[1]?.args.slice(0, 2)).toEqual(["session", "delete"]);
  });
});
