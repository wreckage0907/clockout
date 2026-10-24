import type { Ran, Runner } from "../../src/ai/cli";

/** A fake agent CLI that answers with each of `outputs` in turn, recording every call. */
export function fakeCli(outputs: (Partial<Ran> | string)[]) {
  const calls: {
    cmd: string;
    args: string[];
    input: string;
    cwd: string;
    env?: Record<string, string>;
  }[] = [];
  const run: Runner = async (cmd, args, { input, cwd, env }) => {
    calls.push({ cmd, args, input, cwd, ...(env ? { env } : {}) });
    const next = outputs.shift();
    if (next === undefined) throw new Error("no more outputs");
    const r = typeof next === "string" ? { stdout: next } : next;
    return { stdout: "", stderr: "", exitCode: 0, ...r };
  };
  return { run, calls };
}
