import { z } from "zod";
import {
  answerWith,
  cliFailure,
  inTempDir,
  jsonIn,
  lastLine,
  parseJson,
  type Runner,
  runCli,
  validated,
} from "./cli";
import type { CompleteRequest, LlmBackend } from "./types";

const event = z.object({
  type: z.string(),
  sessionID: z.string().optional(),
  part: z.object({ text: z.string().optional() }).optional(),
  error: z.object({ message: z.string().optional() }).optional(),
});

/**
 * Runs the user's own `opencode run` with the provider they set up in it, as a "clockout" agent
 * that may use no tools, on a private server (`--standalone`) so that agent exists. Can't enforce
 * a schema: the instructions describe it and the answer is validated. opencode always saves the
 * session, so it's deleted straight after (and the opencode source skips Clockout's folders).
 */
export function opencodeCliBackend(model?: string, run: Runner = runCli): LlmBackend {
  const name = "opencode";
  const failure = (said: string) => cliFailure(name, said, "run `opencode auth login`.");
  return {
    id: "opencode",
    label: model ? `${name} (${model})` : name,
    complete<T>(req: CompleteRequest<T>): Promise<T> {
      const env = {
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          agent: {
            clockout: {
              mode: "primary",
              // Here rather than --model, which makes opencode drop the agent's prompt.
              ...(model ? { model } : {}),
              prompt: answerWith(req.system, req.schema),
              permission: { "*": "deny" },
            },
          },
        }),
      };
      const args = ["run", "--standalone", "--format", "json", "--agent", "clockout"];
      return inTempDir((_, cwd) =>
        validated(name, req.schema, async () => {
          const r = await run("opencode", args, { input: req.prompt, cwd, env }).catch(
            (err: Error) => {
              throw new Error(`${name} ${err.message}.`);
            },
          );
          const events = r.stdout
            .split("\n")
            .map((l) => event.safeParse(parseJson(l)))
            .flatMap((e) => (e.success ? [e.data] : []));
          const session = events.find((e) => e.sessionID)?.sessionID;
          if (session)
            await run("opencode", ["session", "delete", session, "--standalone"], {
              input: "",
              cwd,
              env,
            }).catch(() => undefined);
          const error = events.find((e) => e.type === "error")?.error?.message;
          if (error) throw failure(error);
          if (r.exitCode !== 0)
            throw failure(lastLine(r.stderr) || `exited with code ${r.exitCode}`);
          const text = events.flatMap((e) => (e.type === "text" ? [e.part?.text ?? ""] : []));
          return jsonIn(text.at(-1) ?? "");
        }),
      );
    },
  };
}
