import {
  answerWith,
  cliFailure,
  inTempDir,
  jsonIn,
  lastLine,
  type Runner,
  runCli,
  validated,
} from "./cli";
import type { CompleteRequest, LlmBackend } from "./types";

/**
 * Runs the user's own `pi -p` with the provider and model they set up in it. Tools, extensions,
 * skills, MCP and context files off, nothing saved, empty folder. Pi can't enforce a schema, so
 * the instructions describe it and the answer is validated.
 */
export function piCliBackend(model?: string, run: Runner = runCli): LlmBackend {
  const name = "Pi";
  const failure = (said: string) =>
    cliFailure(name, said, "run `pi` and sign in to a provider (/login).");
  return {
    id: "pi",
    label: model ? `${name} (${model})` : name,
    complete<T>(req: CompleteRequest<T>): Promise<T> {
      const args = [
        "-p",
        "--no-session",
        "--no-tools",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-mcp",
        "--no-themes",
        "--no-approve",
        ...(model ? ["--model", model] : []),
        "--system-prompt",
        answerWith(req.system, req.schema),
      ];
      return inTempDir((_, cwd) =>
        validated(name, req.schema, async () => {
          const r = await run("pi", args, { input: req.prompt, cwd }).catch((err: Error) => {
            throw new Error(`${name} ${err.message}.`);
          });
          if (r.exitCode !== 0)
            throw failure(
              lastLine(r.stderr) || lastLine(r.stdout) || `exited with code ${r.exitCode}`,
            );
          return jsonIn(r.stdout);
        }),
      );
    },
  };
}
