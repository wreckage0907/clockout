import { z } from "zod";
import {
  cliFailure,
  cliVersion,
  inTempDir,
  jsonSchema,
  lastLine,
  parseJson,
  type Runner,
  runCli,
  validated,
} from "./cli";
import type { CompleteRequest, LlmBackend } from "./types";

/** Version of the user's installed Claude Code CLI, or null if it isn't on PATH. */
export function detectClaudeCli(env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  return cliVersion("claude", env);
}

const envelope = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
});

/**
 * Runs the user's own `claude` binary on their own login (allowed by Anthropic's terms; we never
 * touch their credentials). Tools off, no MCP servers or settings, nothing saved, empty temp dir.
 */
export function claudeCliBackend(model = "haiku", run: Runner = runCli): LlmBackend {
  const name = "Claude Code";
  const failure = (said: string) => cliFailure(name, said, "run `claude` and type /login.");
  return {
    id: "claude-code",
    label: `${name} (${model})`,
    complete<T>(req: CompleteRequest<T>): Promise<T> {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        JSON.stringify(jsonSchema(req.schema)),
        "--model",
        model,
        "--tools",
        "",
        "--strict-mcp-config",
        "--setting-sources",
        "",
        "--no-session-persistence",
        "--system-prompt",
        req.system,
      ];
      return inTempDir((_, cwd) =>
        validated(name, req.schema, async () => {
          const r = await run("claude", args, { input: req.prompt, cwd }).catch((err: Error) => {
            throw new Error(`${name} ${err.message}.`);
          });
          // A failure still prints the JSON envelope, with the reason in `result`.
          const out = envelope.safeParse(parseJson(r.stdout));
          if (out.success && out.data.is_error)
            throw failure(out.data.result ?? out.data.subtype ?? "error");
          if (r.exitCode !== 0)
            throw failure(lastLine(r.stderr) || `exited with code ${r.exitCode}`);
          if (!out.success) return undefined;
          return out.data.structured_output ?? parseJson(out.data.result ?? "");
        }),
      );
    },
  };
}
