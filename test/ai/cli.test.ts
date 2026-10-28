import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentEnv,
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

  it("gives a helper only what it needs from the environment, never Clockout's secrets", () => {
    const env = agentEnv(
      {
        PATH: "/usr/bin",
        HOME: "/home/dev",
        LANG: "en_US.UTF-8",
        LC_ALL: "C",
        TMPDIR: "/tmp",
        XDG_DATA_HOME: "/data",
        ANTHROPIC_API_KEY: "sk-ant-own",
        CLAUDE_CONFIG_DIR: "/cfg",
        OPENAI_API_KEY: "sk-own",
        OPENROUTER_API_KEY: "or-own",
        AWS_PROFILE: "work",
        SOME_NEW_PROVIDER_API_KEY: "key",
        OPENCODE_CONFIG: "/oc",
        PI_CODING_AGENT_DIR: "/pi",
        GITHUB_TOKEN: "ghp_secret",
        GH_TOKEN: "gho_secret",
        CLOCKOUT_TIMESHEET_TOKEN: "pms_secret",
        CLOCKOUT_CONFIG: "/etc/clockout.toml",
        MY_PMS_TOKEN: "pms_other_secret",
        SSH_AUTH_SOCK: "/agent",
        NPM_TOKEN: "npm_secret",
        EDITOR: "vim",
      },
      ["MY_PMS_TOKEN"],
    );
    expect(Object.keys(env).sort()).toEqual(
      [
        "ANTHROPIC_API_KEY",
        "AWS_PROFILE",
        "CLAUDE_CONFIG_DIR",
        "HOME",
        "LANG",
        "LC_ALL",
        "OPENAI_API_KEY",
        "OPENCODE_CONFIG",
        "OPENROUTER_API_KEY",
        "PATH",
        "PI_CODING_AGENT_DIR",
        "SOME_NEW_PROVIDER_API_KEY",
        "TMPDIR",
        "XDG_DATA_HOME",
      ].sort(),
    );
  });

  it("holds back a withheld name even where a provider pattern would let it through", () => {
    const env = { OPENAI_API_KEY: "k", FOO_API_KEY: "timesheet", GITHUB_TOKEN: "t" };
    expect(agentEnv(env, ["foo_api_key"])).toEqual({ OPENAI_API_KEY: "k" });
  });

  describe("the process a helper runs as", () => {
    afterEach(() => vi.unstubAllEnvs());

    it("starts with the filtered environment plus what the backend adds, not Clockout's own", async () => {
      vi.stubEnv("GITHUB_TOKEN", "ghp_secret");
      vi.stubEnv("GH_TOKEN", "gho_secret");
      vi.stubEnv("CLOCKOUT_TIMESHEET_TOKEN", "pms_secret");
      vi.stubEnv("MY_PMS_TOKEN", "pms_other_secret");
      vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-own");
      const r = await cliRunner(10_000, ["MY_PMS_TOKEN"])(
        process.execPath,
        ["-e", "console.log(JSON.stringify(process.env))"],
        { input: "", cwd: tmpdir(), env: { ADDED_BY_BACKEND: "1" } },
      );
      const seen = JSON.parse(r.stdout) as Record<string, string>;
      expect(seen.ANTHROPIC_API_KEY).toBe("sk-ant-own");
      expect(seen.ADDED_BY_BACKEND).toBe("1");
      expect(seen.PATH).toBeTruthy();
      for (const secret of ["GITHUB_TOKEN", "GH_TOKEN", "CLOCKOUT_TIMESHEET_TOKEN", "MY_PMS_TOKEN"])
        expect(seen).not.toHaveProperty(secret);
    });
  });

  it("says when the helper isn't installed", async () => {
    await expect(
      runCli("clockout-no-such-helper", [], { input: "", cwd: tmpdir() }),
    ).rejects.toThrow("isn't installed");
  });
});
