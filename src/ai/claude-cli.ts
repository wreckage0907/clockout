import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { z } from "zod";
import type { CompleteRequest, LlmBackend } from "./types";

/** Version of the user's installed Claude Code CLI, or null if it isn't on PATH. */
export async function detectClaudeCli(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | null> {
  try {
    const { stdout } = await execa("claude", ["--version"], { env, timeout: 10_000 });
    return stdout.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

const envelope = z.object({
  is_error: z.boolean().optional(),
  subtype: z.string().optional(),
  result: z.string().optional(),
  structured_output: z.unknown().optional(),
});

export type Runner = (args: string[], input: string, cwd: string) => Promise<string>;

const runClaude: Runner = async (args, input, cwd) => {
  const { stdout } = await execa("claude", args, { input, cwd, timeout: 120_000 });
  return stdout;
};

/**
 * Runs the user's own `claude` binary on their own login (allowed by Anthropic's terms; we never
 * touch their credentials). Tools off, no MCP servers or settings, nothing saved, empty temp dir.
 */
export function claudeCliBackend(model = "haiku", run: Runner = runClaude): LlmBackend {
  return {
    id: "claude-code",
    label: `Claude Code (${model})`,
    async complete<T>(req: CompleteRequest<T>): Promise<T> {
      const args = [
        "-p",
        "--output-format",
        "json",
        "--json-schema",
        jsonSchema(req.schema),
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
      const cwd = await mkdtemp(join(tmpdir(), "clockout-ai-"));
      try {
        let lastError = "";
        for (let attempt = 0; attempt < 2; attempt++) {
          const stdout = await run(args, req.prompt, cwd).catch(
            (err: Error & { stderr?: string }) => {
              throw new Error(`Claude Code failed: ${(err.stderr || err.message).split("\n")[0]}`);
            },
          );
          const out = envelope.safeParse(safeJson(stdout));
          if (!out.success || out.data.is_error) {
            lastError = out.success
              ? (out.data.result ?? out.data.subtype ?? "error")
              : "unreadable output";
            continue;
          }
          const value = req.schema.safeParse(
            out.data.structured_output ?? safeJson(out.data.result ?? ""),
          );
          if (value.success) return value.data;
          lastError = "output didn't match the expected shape";
        }
        throw new Error(`Claude Code: ${lastError}`);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  };
}

/** JSON Schema for --json-schema, without the "$schema" draft marker the CLI doesn't resolve. */
export function jsonSchema(schema: z.ZodType): string {
  const { $schema: _, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return JSON.stringify(rest);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
