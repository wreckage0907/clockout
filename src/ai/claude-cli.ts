import { execa } from "execa";

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
