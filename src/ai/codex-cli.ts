import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  cliFailure,
  inTempDir,
  jsonSchema,
  lastLine,
  parseJson,
  type Runner,
  runCli,
  strictSchema,
  validated,
} from "./cli";
import type { CompleteRequest, LlmBackend } from "./types";

/**
 * Runs the user's own `codex exec` on their own login. Codex has no switch for tools, so it runs
 * in a read-only sandbox (no network, no writes) in an empty folder, without the user's config
 * (MCP servers, hooks), with nothing saved. The schema is enforced in OpenAI's strict form.
 * Codex has no system prompt either: the instructions go first in the prompt.
 */
export function codexCliBackend(model?: string, run: Runner = runCli): LlmBackend {
  const name = "Codex";
  const failure = (said: string) => cliFailure(name, said, "run `codex login`.");
  return {
    id: "codex",
    label: model ? `${name} (${model})` : name,
    complete<T>(req: CompleteRequest<T>): Promise<T> {
      return inTempDir(async (dir, cwd) => {
        const schemaFile = join(dir, "schema.json");
        const outFile = join(dir, "answer.json");
        await writeFile(schemaFile, JSON.stringify(strictSchema(jsonSchema(req.schema))));
        const args = [
          "exec",
          "--output-schema",
          schemaFile,
          "--output-last-message",
          outFile,
          "--sandbox",
          "read-only",
          "--ephemeral",
          "--skip-git-repo-check",
          "--ignore-user-config",
          "--ignore-rules",
          "--color",
          "never",
          "-c",
          'model_reasoning_effort="low"',
          ...(model ? ["--model", model] : []),
          "--cd",
          cwd,
          "-",
        ];
        const input = `<instructions>\n${req.system}\n</instructions>\n\n${req.prompt}`;
        return validated(name, req.schema, async () => {
          const r = await run("codex", args, { input, cwd }).catch((err: Error) => {
            throw new Error(`${name} ${err.message}.`);
          });
          if (r.exitCode !== 0)
            throw failure(codexError(r.stderr) || `exited with code ${r.exitCode}`);
          const answer = await readFile(outFile, "utf8").catch(() => r.stdout);
          return parseJson(answer.trim());
        });
      });
    },
  };
}

/** Codex prints `ERROR: <message or API error JSON>` lines; the message from the last one. */
export function codexError(stderr: string): string {
  const line = stderr
    .split("\n")
    .filter((l) => l.startsWith("ERROR:"))
    .at(-1)
    ?.slice(6)
    .trim();
  if (!line) return lastLine(stderr);
  const json = parseJson(line);
  if (json && typeof json === "object" && "error" in json) {
    const e = (json as { error: unknown }).error;
    if (e && typeof e === "object" && "message" in e && typeof e.message === "string")
      return e.message;
  }
  return line;
}
