import { spawn, spawnSync } from "node:child_process";
import { bin, type Sandbox } from "../e2e/helpers";

// The review screen in a real pseudo-terminal, driven by test/tty/drive.py: Ink's own start-up,
// keys, pastes, resizes and signals, and what reaches the terminal on the way out.

export type Step =
  | { wait: string; timeout?: number }
  /** Fails if the text shows up within `within` seconds. */
  | { absent: string; within?: number }
  | { send: string }
  | { resize: [number, number] }
  | { signal: "TERM" | "HUP" | "INT" }
  | { sleep: number };

export interface PtyRun {
  code: number | null;
  signal: string | null;
  /** Everything written to the terminal, escape sequences included. */
  output: string;
  /** The wait that timed out, with the text seen since the one before. */
  failed: { step: Step; seen: string } | null;
}

const helper = new URL("./drive.py", import.meta.url).pathname;

export const hasPython = spawnSync("python3", ["--version"]).status === 0;

export const KEY = {
  enter: "\r",
  esc: "\u001b",
  ctrlC: "\u0003",
  ctrlS: "\u0013",
  paste: (text: string) => `\u001b[200~${text}\u001b[201~`,
};

/** What a terminal needs to be left as it was: mouse reports off, main screen, cursor shown. */
export const RESTORE = {
  mouseOff: "\u001b[?1000l",
  mainScreen: "\u001b[?1049l",
  cursorShown: "\u001b[?25h",
};

export function runInPty(
  sb: Sandbox,
  args: string[],
  steps: Step[],
  opts: { env?: Record<string, string>; cols?: number; rows?: number; timeout?: number } = {},
): Promise<PtyRun> {
  const spec = {
    cmd: [process.execPath, bin, ...args],
    env: { ...sb.env, TERM: "xterm-256color", COLORTERM: "truecolor", ...opts.env },
    cwd: sb.home,
    cols: opts.cols ?? 100,
    rows: opts.rows ?? 30,
    timeout: opts.timeout ?? 30,
    steps,
  };
  return new Promise((resolve, reject) => {
    const child = spawn("python3", ["-I", helper]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`drive.py failed (${code}): ${err}`));
      resolve(JSON.parse(out) as PtyRun);
    });
    child.stdin.end(JSON.stringify(spec));
  });
}
