import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

export interface MouseEvent {
  /** 0-based column and row on screen. */
  x: number;
  y: number;
  kind: "press" | "release" | "move" | "wheelUp" | "wheelDown";
  button: "left" | "middle" | "right" | "none";
}

// SGR mouse reports: ESC [ < button ; column ; row (M press/move, m release).
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
const SGR = /\u001b\[<(\d+);(\d+);(\d+)([Mm])/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: terminal escape sequence
const PARTIAL = /\u001b(?:\[(?:<[\d;]*)?)?$/;

function parseSgr(code: number, col: number, row: number, final: string): MouseEvent {
  const base = code & 3;
  const button = base === 0 ? "left" : base === 1 ? "middle" : base === 2 ? "right" : "none";
  const at = { x: col - 1, y: row - 1 };
  if (code & 64) return { ...at, kind: base === 0 ? "wheelUp" : "wheelDown", button: "none" };
  if (code & 32) return { ...at, kind: "move", button };
  return { ...at, kind: final === "m" ? "release" : "press", button };
}

/**
 * Splits terminal input into mouse events and everything else. A trailing piece that could be
 * the start of a mouse report is held back until the next chunk. Pure.
 */
export function splitMouse(pending: string, chunk: string) {
  const text = pending + chunk;
  const events: MouseEvent[] = [];
  const rest = text.replace(SGR, (_m, b: string, c: string, r: string, f: string) => {
    events.push(parseSgr(Number(b), Number(c), Number(r), f));
    return "";
  });
  const held = PARTIAL.exec(rest)?.[0] ?? "";
  // A lone ESC is the Escape key; only hold sequences that have started a mouse report.
  const keep = held.startsWith("\u001b[<") ? held : "";
  return { events, rest: keep ? rest.slice(0, -keep.length) : rest, pending: keep };
}

/** Escape codes that turn click, drag and motion reporting on (SGR encoding) and off. */
export const MOUSE_ON = "\u001b[?1000h\u001b[?1003h\u001b[?1006h";
export const MOUSE_OFF = "\u001b[?1006l\u001b[?1003l\u001b[?1000l";

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
  const onData = (data: Buffer | string) => {
    const r = splitMouse(pending, data.toString());
    pending = r.pending;
    for (const e of r.events) mouse.emit("mouse", e);
    if (r.rest) proxy.write(r.rest);
  };
  input.on("data", onData);
  return {
    stdin: proxy as unknown as NodeJS.ReadStream,
    mouse,
    stop: () => input.off("data", onData),
  };
}
