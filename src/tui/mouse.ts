import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export interface MouseEvent {
  /** 0-based column and row on screen. */
  x: number;
  y: number;
  kind: "press" | "release" | "move" | "wheelUp" | "wheelDown";
  button: "left" | "middle" | "right" | "none";
  /** Shift was held, for extending a selection. */
  shift: boolean;
  /** Alt / Option was held: the same as Shift where a multiplexer keeps Shift-clicks. */
  alt: boolean;
}

// SGR mouse reports: ESC [ < button ; column ; row (M press/move, m release).
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
const SGR = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
const PARTIAL = /\u001b(?:\[(?:<[\d;]*)?)?$/;

function parseSgr(code: number, col: number, row: number, final: string): MouseEvent {
  const base = code & 3;
  const button = base === 0 ? "left" : base === 1 ? "middle" : base === 2 ? "right" : "none";
  const at = { x: col - 1, y: row - 1, shift: Boolean(code & 4), alt: Boolean(code & 8) };
  if (code & 64) return { ...at, kind: base === 0 ? "wheelUp" : "wheelDown", button: "none" };
  if (code & 32) return { ...at, kind: "move", button };
  return { ...at, kind: final === "m" ? "release" : "press", button };
}

/**
 * Splits terminal input into mouse events and everything else. A trailing piece that could be
 * the start of a mouse report (ESC, ESC [, ESC [ < …) is held back as `pending` for the next
 * chunk; `withMouse` hands it on as typed input if nothing follows. Pure.
 */
export function splitMouse(pending: string, chunk: string) {
  const text = pending + chunk;
  const events: MouseEvent[] = [];
  const rest = text.replace(SGR, (_m, b: string, c: string, r: string, f: string) => {
    events.push(parseSgr(Number(b), Number(c), Number(r), f));
    return "";
  });
  const held = PARTIAL.exec(rest)?.[0] ?? "";
  return { events, rest: held ? rest.slice(0, -held.length) : rest, pending: held };
}

/** How long a possible start of a mouse report waits for the rest before it counts as keys. */
const HOLD_MS = 10;

/**
 * Escape codes that turn click, drag and motion reporting on (SGR encoding) and off. `CSI > 1 s`
 * (XTSHIFTESCAPE) asks terminals like Ghostty and xterm to send Shift-clicks to the app
 * instead of keeping them for their own text selection; `CSI > 0 s` hands them back.
 */
export const MOUSE_ON = "\u001b[?1000h\u001b[?1003h\u001b[?1006h\u001b[>1s";
export const MOUSE_OFF = "\u001b[>0s\u001b[?1006l\u001b[?1003l\u001b[?1000l";

/**
 * Wraps a TTY stdin so Ink sees keys and pastes as usual while mouse reports go to `mouse`.
 * Ink would otherwise drop them. Pass `stdin` to `render()`.
 */
export function withMouse(input: NodeJS.ReadStream) {
  const mouse = new EventEmitter();
  const proxy = new PassThrough() as PassThrough & Partial<NodeJS.ReadStream>;
  Object.assign(proxy, {
    isTTY: input.isTTY,
    setRawMode: (on: boolean) => {
      input.setRawMode?.(on);
      return proxy;
    },
    ref: () => {
      input.ref();
      return proxy;
    },
    unref: () => {
      input.unref();
      return proxy;
    },
  });
  let pending = "";
  let timer: NodeJS.Timeout | undefined;
  const onData = (data: Buffer | string) => {
    clearTimeout(timer);
    const r = splitMouse(pending, data.toString());
    pending = r.pending;
    for (const e of r.events) mouse.emit("mouse", e);
    if (r.rest) proxy.write(r.rest);
    // Terminals send a report in one write, so a piece still pending after a moment was a key
    // (usually Escape): pass it on.
    if (pending)
      timer = setTimeout(() => {
        proxy.write(pending);
        pending = "";
      }, HOLD_MS);
  };
  input.on("data", onData);
  return {
    stdin: proxy as unknown as NodeJS.ReadStream,
    mouse,
    stop: () => {
      clearTimeout(timer);
      input.off("data", onData);
    },
  };
}
