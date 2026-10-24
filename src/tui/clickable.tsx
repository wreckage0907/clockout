import type { EventEmitter } from "node:events";
import { Box, type BoxProps, type DOMElement, measureElement } from "ink";
import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type { MouseEvent } from "./mouse";

export interface ClickModifiers {
  shift: boolean;
  alt: boolean;
}

interface Handlers {
  click?: (modifiers: ClickModifiers) => void;
  wheel?: (dir: 1 | -1) => void;
  setHover?: (on: boolean) => void;
  /** Set on an overlay's own box: called for clicks that land outside it. */
  outside?: () => void;
}

interface Target {
  ref: RefObject<DOMElement | null>;
  layer: number;
  /** Read at event time, so a box that gains or loses `onClick` after mounting is current. */
  on: RefObject<Handlers>;
}

const Registry = createContext<{ add: (t: Target) => () => void } | null>(null);
const Layer = createContext(0);

function inside(t: Target, x: number, y: number): number | null {
  const node = t.ref.current;
  if (!node) return null;
  const r = measureElement(node);
  if (r.width === 0 || r.height === 0) return null;
  return x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
    ? r.width * r.height
    : null;
}

/**
 * Routes mouse events to `Clickable`s: the innermost one under the pointer on the topmost
 * layer wins, and a click outside an open overlay closes it. Without `events`, nothing is
 * clickable and the app works as before by keyboard.
 */
export function MouseProvider({
  events,
  children,
}: {
  events: EventEmitter | null;
  children: ReactNode;
}) {
  const targets = useRef(new Set<Target>());
  const hovered = useRef<Target | null>(null);
  const [registry] = useState(() => ({
    add(t: Target) {
      targets.current.add(t);
      return () => {
        targets.current.delete(t);
        if (hovered.current === t) hovered.current = null;
      };
    },
  }));

  useEffect(() => {
    if (!events) return;
    const pick = (x: number, y: number, want: (t: Target) => boolean) => {
      const all = [...targets.current];
      const top = Math.max(0, ...all.map((t) => t.layer));
      let best: Target | null = null;
      let bestArea = Number.POSITIVE_INFINITY;
      for (const t of all) {
        if (t.layer !== top || !want(t)) continue;
        const area = inside(t, x, y);
        if (area !== null && area < bestArea) {
          best = t;
          bestArea = area;
        }
      }
      return { best, top, all };
    };
    const onMouse = (e: MouseEvent) => {
      if (e.kind === "move") {
        const { best } = pick(e.x, e.y, (t) => Boolean(t.on.current.click));
        if (best !== hovered.current) {
          hovered.current?.on.current.setHover?.(false);
          best?.on.current.setHover?.(true);
          hovered.current = best;
        }
        return;
      }
      if (e.kind === "wheelUp" || e.kind === "wheelDown") {
        const { best } = pick(e.x, e.y, (t) => Boolean(t.on.current.wheel));
        best?.on.current.wheel?.(e.kind === "wheelUp" ? -1 : 1);
        return;
      }
      if (e.kind !== "press" || e.button !== "left") return;
      const { best, top, all } = pick(e.x, e.y, (t) =>
        Boolean(t.on.current.click || t.on.current.outside),
      );
      const click = best?.on.current.click;
      if (click) return click({ shift: e.shift, alt: e.alt });
      if (!best && top > 0) for (const t of all) if (t.layer === top) t.on.current.outside?.();
    };
    events.on("mouse", onMouse);
    return () => {
      events.off("mouse", onMouse);
    };
  }, [events]);

  return <Registry value={registry}>{children}</Registry>;
}

function useTarget(handlers: Handlers) {
  const ref = useRef<DOMElement>(null);
  const registry = useContext(Registry);
  const layer = useContext(Layer);
  const on = useRef(handlers);
  on.current = handlers;
  useEffect(() => registry?.add({ ref, layer, on }), [registry, layer]);
  return ref;
}

/** A box you can click (and scroll over). Children may be a function of hover. */
export function Clickable({
  onClick,
  onWheel,
  children,
  ...box
}: Omit<BoxProps, "children"> & {
  onClick?: (modifiers: ClickModifiers) => void;
  onWheel?: (dir: 1 | -1) => void;
  children: ReactNode | ((hover: boolean) => ReactNode);
}) {
  const [hover, setHover] = useState(false);
  const ref = useTarget({ click: onClick, wheel: onWheel, setHover });
  return (
    <Box ref={ref} {...box}>
      {typeof children === "function" ? children(hover) : children}
    </Box>
  );
}

/**
 * An overlay: everything clickable inside it sits above the screen, and a click outside it
 * calls `onOutside` (usually close).
 */
export function Overlay({
  onOutside,
  children,
  ...box
}: Omit<BoxProps, "children"> & { onOutside?: () => void; children: ReactNode }) {
  const parent = useContext(Layer);
  return (
    <Layer value={parent + 1}>
      <OverlayBox onOutside={onOutside} {...box}>
        {children}
      </OverlayBox>
    </Layer>
  );
}

function OverlayBox({
  onOutside,
  children,
  ...box
}: Omit<BoxProps, "children"> & { onOutside?: () => void; children: ReactNode }) {
  // Registers on the overlay's own layer: it absorbs clicks on its padding.
  const ref = useTarget({ click: () => {}, outside: onOutside ?? (() => {}) });
  return (
    <Box ref={ref} {...box}>
      {children}
    </Box>
  );
}
