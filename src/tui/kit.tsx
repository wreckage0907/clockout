import { Box, type Key, Text, useInput, usePaste } from "ink";
import { type ReactNode, useEffect, useState } from "react";
import { addDays, parseDuration } from "../core/time";
import type { Segment } from "./cards";
import { Clickable, Overlay } from "./clickable";
import { COMMANDS, type SlashCommand } from "./slash";
import { hm, T } from "./theme";

// ── Colour ──────────────────────────────────────────────────────────────────

function rgb(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** `t` of the way from `a` to `b`. */
export function mix(a: string, b: string, t: number): string {
  const [ar, ag, ab] = rgb(a);
  const [br, bg, bb] = rgb(b);
  const ch = (x: number, y: number) =>
    Math.round(x + (y - x) * t)
      .toString(16)
      .padStart(2, "0");
  return `#${ch(ar, br)}${ch(ag, bg)}${ch(ab, bb)}`;
}

// ── Wordmark on the hours bar ───────────────────────────────────────────────

// Four-row block letters in the opencode style. "_" is a shaded counter, "*" the clock hand.
const GLYPHS: Record<string, string[]> = {
  c: ["    ", "█▀▀▀", "█___", "▀▀▀▀"],
  l: ["█", "█", "█", "▀"],
  o: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
  "◷": ["    ", "█▀▀█", "█_*█", "▀▀▀▀"],
  k: ["█   ", "█ ▄▀", "█▀▄ ", "▀  ▀"],
  u: ["    ", "█  █", "█__█", "▀▀▀▀"],
  t: [" █  ", "▀█▀▀", " █__", " ▀▀▀"],
};

/** Each row of the wordmark as cells: the character and whether it's in "out" (bright). */
function wordmarkRows(): { ch: string; bright: boolean }[][] {
  const word = (letters: string) =>
    [0, 1, 2, 3].map((r) => [...letters].map((l) => GLYPHS[l]?.[r] ?? "").join(" "));
  const left = word("cl◷ck");
  const right = word("out");
  return left.map((l, r) => [
    ...[...l].map((ch) => ({ ch, bright: false })),
    { ch: " ", bright: false },
    ...[...(right[r] ?? "")].map((ch) => ({ ch, bright: true })),
  ]);
}

/**
 * The wordmark standing on the day's hours: the band behind the letters fills left to right in
 * each project's colour, in proportion to its hours against your target. The rest stays dark.
 */
export function BarWordmark({
  segments,
  target,
  pad = 3,
}: {
  segments: Segment[];
  /** Minutes. */
  target: number;
  pad?: number;
}) {
  const rows = wordmarkRows();
  const inner = rows[0]?.length ?? 0;
  const width = inner + pad * 2;
  const total = segments.reduce((s, x) => s + x.minutes, 0);
  const per = Math.max(target, total) / width;
  const empty = T.panel;
  const colAt: string[] = [];
  for (const s of segments) {
    const n = Math.round(s.minutes / per);
    for (let i = 0; i < n && colAt.length < width; i++) colAt.push(mix(T.bg, s.color, 0.55));
  }
  while (colAt.length < width) colAt.push(empty);

  const line = (cells: { ch: string; bright: boolean }[] | null, key: number) => (
    <Text key={key}>
      {Array.from({ length: width }, (_, x) => {
        const bg = colAt[x] ?? empty;
        const cell = cells && x >= pad && x < pad + inner ? cells[x - pad] : undefined;
        const fg = cell?.bright ? T.text : "#c9c9cf";
        const ch = cell?.ch ?? " ";
        const k = `${x}`;
        if (ch === "_")
          return (
            <Text key={k} backgroundColor={mix(bg, T.bg, 0.45)}>
              {" "}
            </Text>
          );
        if (ch === "*")
          return (
            <Text key={k} color={T.primary} backgroundColor={mix(bg, T.bg, 0.45)}>
              ▀
            </Text>
          );
        return (
          <Text key={k} color={fg} backgroundColor={bg}>
            {ch}
          </Text>
        );
      })}
    </Text>
  );
  return (
    <Box flexDirection="column">
      {line(null, -1)}
      {rows.map((r, i) => line(r, i))}
      {line(null, 9)}
    </Box>
  );
}

/** A thin version of the same bar, for the day view's header. */
export function HoursBar({
  segments,
  target,
  width,
}: {
  segments: Segment[];
  target: number;
  width: number;
}) {
  const total = segments.reduce((s, x) => s + x.minutes, 0);
  const per = Math.max(target, total) / width;
  let used = 0;
  return (
    <Text>
      {segments.map((s) => {
        const n = Math.min(width - used, Math.round(s.minutes / per));
        used += n;
        return (
          <Text key={s.label} color={s.color}>
            {"▀".repeat(Math.max(0, n))}
          </Text>
        );
      })}
      <Text color={T.elementHi}>{"▀".repeat(Math.max(0, width - used))}</Text>
    </Text>
  );
}

// ── Text entry ──────────────────────────────────────────────────────────────

/**
 * Typed keys and pasted dictation for an input. Pastes arrive whole (bracketed paste), so
 * dictated words are never read as shortcuts, and newlines never submit.
 */
export function useDraft(active: boolean, initial = "") {
  const [value, setValue] = useState(initial);
  usePaste(
    (text) => {
      const clean = text.replace(/\s*[\r\n]+\s*/g, " ").trim();
      setValue((v) => `${v}${v && !v.endsWith(" ") ? " " : ""}${clean}`);
    },
    { isActive: active },
  );
  /** Handles editing keys; true when the key was used. */
  const edit = (ch: string, key: Key): boolean => {
    if (key.backspace || key.delete) {
      setValue((v) => v.slice(0, -1));
      return true;
    }
    if (key.ctrl && ch === "u") {
      setValue("");
      return true;
    }
    if (ch && !key.ctrl && !key.meta && !key.tab && !key.return && !key.escape) {
      setValue((v) => v + ch.replace(/[\r\n]/g, " "));
      return true;
    }
    return false;
  };
  return { value, setValue, edit };
}

export function Typed({ value, placeholder }: { value: string; placeholder: string }) {
  return value === "" ? (
    <Text>
      <Text inverse color={T.muted}>
        {placeholder.slice(0, 1)}
      </Text>
      <Text color={T.muted}>{placeholder.slice(1)}</Text>
    </Text>
  ) : (
    <Text color={T.text}>
      {value}
      <Text inverse> </Text>
    </Text>
  );
}

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function Spinner() {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color={T.primary}>{FRAMES[i]}</Text>;
}

// ── Dates ───────────────────────────────────────────────────────────────────

/** "Fri 16 Oct" */
export function longDate(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

/** "Today", "Yesterday", or the weekday. */
function dayWord(date: string, today: string): string {
  if (date === today) return "Today";
  if (date === addDays(today, -1)) return "Yesterday";
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en", {
    weekday: "long",
    timeZone: "UTC",
  });
}

const DOW = ["S", "M", "T", "W", "T", "F", "S"];

/**
 * A month dropdown that opens above the chat bar's date: Sunday-first, ‹ › for months, a dot on
 * days that already have a draft, Yesterday and Today below. Esc or a click outside closes it.
 */
export function DatePicker({
  date,
  today,
  hasDraft,
  left,
  top,
  bottom,
  onPick,
  onClose,
}: {
  date: string;
  today: string;
  hasDraft: (date: string) => boolean;
  left: number;
  /** Opens downward from this row (home), or upward from `bottom` (day view). */
  top?: number;
  bottom?: number;
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState(date);
  const [month, setMonth] = useState(date.slice(0, 7));
  const first = new Date(`${month}-01T12:00:00Z`);
  const lead = first.getUTCDay();
  const cells = Array.from({ length: 42 }, (_, i) => addDays(`${month}-01`, i - lead));
  const shiftMonth = (n: number) => {
    const d = new Date(`${month}-15T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + n);
    setMonth(d.toISOString().slice(0, 7));
  };
  const move = (n: number) => {
    const next = addDays(sel, n);
    setSel(next);
    setMonth(next.slice(0, 7));
  };

  useInput((_ch, key) => {
    if (key.escape) return onClose();
    if (key.leftArrow) return move(-1);
    if (key.rightArrow) return move(1);
    if (key.upArrow) return move(-7);
    if (key.downArrow) return move(7);
    if (key.return) return onPick(sel);
  });

  const label = first.toLocaleDateString("en", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  const weeks = [0, 1, 2, 3, 4, 5].filter((w) => w < 5 || cells[w * 7]?.startsWith(month));
  return (
    <Overlay
      onOutside={onClose}
      position="absolute"
      left={left}
      top={top}
      bottom={bottom}
      flexDirection="column"
      backgroundColor={T.panel}
      borderStyle="round"
      borderColor={T.border}
      borderBackgroundColor={T.panel}
      paddingX={1}
    >
      <Box justifyContent="space-between" width={28} marginBottom={1}>
        <Text color={T.text}> {label}</Text>
        <Box gap={2}>
          <Clickable onClick={() => shiftMonth(-1)}>
            {(h) => <Text color={h ? T.text : T.muted}>‹</Text>}
          </Clickable>
          <Clickable onClick={() => shiftMonth(1)}>
            {(h) => <Text color={h ? T.text : T.muted}>›</Text>}
          </Clickable>
        </Box>
      </Box>
      <Text color={T.faint}>{DOW.map((d) => ` ${d}  `).join("")}</Text>
      {weeks.map((w) => (
        <Box key={w}>
          {cells.slice(w * 7, w * 7 + 7).map((d) => {
            const num = String(Number(d.slice(8))).padStart(2);
            const dot = hasDraft(d) ? "·" : " ";
            return (
              <Clickable key={d} onClick={() => onPick(d)}>
                {(hover) =>
                  d === sel ? (
                    <Text backgroundColor="#b8b8bd" color={T.onPrimary} bold>
                      {`${num}${dot} `}
                    </Text>
                  ) : (
                    <Text
                      backgroundColor={hover ? T.elementHi : undefined}
                      color={d.startsWith(month) ? T.text : T.faint}
                    >
                      {num}
                      <Text color={T.primary}>{dot}</Text>{" "}
                    </Text>
                  )
                }
              </Clickable>
            );
          })}
        </Box>
      ))}
      <Box marginTop={1} gap={1}>
        <Button label="Yesterday" onClick={() => onPick(addDays(today, -1))} />
        <Button label="Today" onClick={() => onPick(today)} />
      </Box>
    </Overlay>
  );
}

// ── Chat bar ────────────────────────────────────────────────────────────────

/**
 * The one input: a filled panel with a mint bar on the left, your words on the first line and,
 * on the second, the day it applies to (click to change) and its buttons.
 */
export function ChatBar({
  value,
  placeholder,
  width,
  date,
  today,
  onDate,
  actions,
  busy,
}: {
  value: string;
  placeholder: string;
  width: number;
  date: string;
  today: string;
  onDate: () => void;
  actions: ReactNode;
  /** Shown instead of the text while something's running, e.g. "Asking Claude Code…". */
  busy?: string | null;
}) {
  return (
    <Box
      flexDirection="column"
      width={width}
      flexShrink={0}
      backgroundColor={T.element}
      borderStyle="bold"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeftColor={T.primary}
      paddingX={2}
      paddingY={1}
    >
      <Text wrap="truncate-start">
        {busy ? (
          <Text color={T.muted}>
            <Spinner /> {busy}
          </Text>
        ) : (
          <Typed value={value} placeholder={placeholder} />
        )}
      </Text>
      <Box height={1} />
      <Box justifyContent="space-between">
        <Clickable onClick={onDate}>
          {(hover) => (
            <Text>
              <Text color={T.primary}>{dayWord(date, today)}</Text>
              <Text color={hover ? T.text : T.muted} underline={hover}>
                {" · "}
                {longDate(date)} ▾
              </Text>
            </Text>
          )}
        </Clickable>
        <Box gap={1}>{actions}</Box>
      </Box>
    </Box>
  );
}

/**
 * The commands a `/` in the chat bar could be, under or over the bar like the date picker. It
 * never takes the keys: the chat bar keeps typing, and the app moves `sel` with ↑↓.
 */
export function SlashMenu({
  commands,
  sel,
  typed,
  width,
  left,
  top,
  bottom,
  onPick,
}: {
  commands: SlashCommand[];
  sel: number;
  /** What's typed, for "No command /…" when nothing matches. */
  typed: string;
  width: number;
  left: number;
  top?: number;
  bottom?: number;
  onPick: (c: SlashCommand) => void;
}) {
  const label = (c: SlashCommand) => `/${c.name}${c.args ? ` ${c.args}` : ""}`;
  const nameW = Math.max(...COMMANDS.map((c) => label(c).length)) + 2;
  return (
    <Overlay
      position="absolute"
      left={left}
      top={top}
      bottom={bottom}
      width={width}
      flexDirection="column"
      backgroundColor={T.panel}
      borderStyle="round"
      borderColor={T.border}
      borderBackgroundColor={T.panel}
      paddingX={1}
    >
      {commands.length === 0 ? (
        <Text color={T.muted}>No command {typed.split(/\s+/)[0]} · ⌫ to see them all</Text>
      ) : (
        commands.map((c, i) => (
          <Clickable key={c.name} onClick={() => onPick(c)}>
            {(hover) => (
              <Box
                width={width - 4}
                backgroundColor={i === sel ? T.elementHi : hover ? T.element : undefined}
                paddingX={1}
              >
                <Box width={nameW} flexShrink={0}>
                  <Text wrap="truncate-end">
                    <Text color={i === sel ? T.primary : T.text} bold={i === sel}>
                      /{c.name}
                    </Text>
                    {c.args ? <Text color={T.faint}> {c.args}</Text> : null}
                  </Text>
                </Box>
                <Box flexGrow={1} flexShrink={1}>
                  <Text color={T.muted} wrap="truncate-end">
                    {c.about}
                  </Text>
                </Box>
                {c.key ? (
                  <Box flexShrink={0}>
                    <Text color={T.faint}> {c.key}</Text>
                  </Box>
                ) : null}
              </Box>
            )}
          </Clickable>
        ))
      )}
      <Text color={T.faint}>↑↓ choose · tab fills in · enter runs · esc clears</Text>
    </Overlay>
  );
}

// ── Buttons ─────────────────────────────────────────────────────────────────

type Tone = "neutral" | "primary" | "ask" | "quiet";

const FILL: Record<Tone, string> = {
  neutral: T.elementHi,
  primary: T.primary,
  ask: T.ask,
  quiet: T.element,
};

/** Something to click. Filled tones carry dark text; hovering lightens it. Disabled ones are faint. */
export function Button({
  label,
  onClick,
  tone = "neutral",
  focused = false,
  disabled = false,
}: {
  label: string;
  onClick?: () => void;
  tone?: Tone;
  focused?: boolean;
  disabled?: boolean;
}) {
  if (disabled)
    return (
      <Box flexShrink={0}>
        <Text backgroundColor={FILL[tone]} color={T.faint}>{` ${label} `}</Text>
      </Box>
    );
  return (
    <Clickable onClick={onClick} flexShrink={0}>
      {(hover) => {
        const filled = tone === "primary" || tone === "ask";
        const base = focused ? (filled ? mix(FILL[tone], T.text, 0.4) : T.text) : FILL[tone];
        const bg = hover ? mix(base, T.text, filled || focused ? 0.25 : 0.12) : base;
        const fg = filled || focused ? T.onPrimary : tone === "quiet" ? T.muted : T.text;
        return (
          <Text backgroundColor={bg} color={fg} bold={filled || focused}>
            {` ${label} `}
          </Text>
        );
      }}
    </Clickable>
  );
}

// ── Duration pill ───────────────────────────────────────────────────────────

/**
 * A duration big enough to read at a glance, in a box you can click to type a new one.
 * − and + beside it nudge by a step. Edited values are mint so you can see what you changed.
 */
export function Pill({
  minutes,
  step,
  editing = false,
  text = "",
  edited = false,
  dim = false,
  onEdit,
  onChange,
}: {
  minutes: number;
  step: number;
  /** The pill is an input right now. */
  editing?: boolean;
  /** What's been typed while editing. */
  text?: string;
  edited?: boolean;
  dim?: boolean;
  onEdit?: () => void;
  onChange?: (minutes: number) => void;
}) {
  const bad = text !== "" && parseDuration(text) === null;
  return (
    <Box alignItems="center" gap={1} flexShrink={0}>
      {onChange ? (
        <Button
          label="−"
          tone="quiet"
          disabled={minutes <= step}
          onClick={() => onChange(minutes - step)}
        />
      ) : null}
      <Clickable onClick={onEdit}>
        {(hover) => (
          <Box
            borderStyle="round"
            borderColor={editing ? T.primary : hover ? T.muted : dim ? T.elementHi : T.border}
            width={11}
            justifyContent="center"
          >
            {editing ? (
              <Text color={bad ? T.danger : T.text}>
                {text}
                <Text inverse> </Text>
              </Text>
            ) : (
              <Text color={dim ? T.faint : edited ? T.primary : T.text} bold={!dim}>
                {hm(minutes)}
              </Text>
            )}
          </Box>
        )}
      </Clickable>
      {onChange ? <Button label="+" tone="quiet" onClick={() => onChange(minutes + step)} /> : null}
    </Box>
  );
}

// ── Overlays ────────────────────────────────────────────────────────────────

/** A centred panel over the screen: title left, a clickable ✕ right. Click outside closes. */
export function Dialog({
  title,
  width,
  screen,
  onClose,
  children,
}: {
  title: string;
  width: number;
  screen: { width: number; height: number };
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <Overlay
      onOutside={onClose}
      position="absolute"
      left={Math.max(0, Math.floor((screen.width - width) / 2))}
      top={1}
      width={width}
      flexDirection="column"
      backgroundColor={T.panel}
      borderStyle="round"
      borderColor={T.border}
      borderBackgroundColor={T.panel}
      paddingX={2}
      paddingY={1}
    >
      <Box justifyContent="space-between">
        <Text color={T.text} bold>
          {title}
        </Text>
        <Clickable onClick={onClose}>
          {(hover) => <Text color={hover ? T.text : T.muted}>esc ✕</Text>}
        </Clickable>
      </Box>
      <Box height={1} />
      {children}
    </Overlay>
  );
}

/** A short note that clears itself. */
export function Toast({ text, bottom }: { text: string; bottom: number }) {
  return (
    <Box
      position="absolute"
      bottom={bottom}
      right={2}
      backgroundColor={T.elementHi}
      borderStyle="bold"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeftColor={T.primary}
      paddingX={2}
    >
      <Text color={T.text}>{text}</Text>
    </Box>
  );
}

export function useToast(): [string | null, (text: string) => void] {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!text) return;
    const t = setTimeout(() => setText(null), 2600);
    return () => clearTimeout(t);
  }, [text]);
  return [text, setText];
}

/**
 * Time nothing recorded: pick a project, set how long, say what it was. Clockout finds a place
 * for it in the day; you never pick a clock time.
 */
export function AddTimeDialog({
  projects,
  step,
  screen,
  onAdd,
  onClose,
}: {
  projects: string[];
  step: number;
  screen: { width: number; height: number };
  onAdd: (project: string, minutes: number, summary: string) => void;
  onClose: () => void;
}) {
  const [project, setProject] = useState(0);
  const [minutes, setMinutes] = useState(60);
  const draft = useDraft(true);
  const submit = () => {
    const p = projects[project];
    if (p) onAdd(p, minutes, draft.value.trim());
  };
  useInput((ch, key) => {
    if (key.escape) return onClose();
    if (key.return) return submit();
    if (key.tab)
      return setProject((i) => (i + (key.shift ? projects.length - 1 : 1)) % projects.length);
    if (key.upArrow) return setMinutes((m) => m + step);
    if (key.downArrow) return setMinutes((m) => Math.max(step, m - step));
    draft.edit(ch, key);
  });
  const width = Math.min(64, screen.width - 4);
  return (
    <Dialog title="Add time" width={width} screen={screen} onClose={onClose}>
      <Text color={T.muted}>Project</Text>
      <Box gap={1} flexWrap="wrap" width={width - 6}>
        {projects.map((p, i) => (
          <Button
            key={p}
            label={p}
            tone={i === project ? "primary" : "neutral"}
            onClick={() => setProject(i)}
          />
        ))}
      </Box>
      <Box height={1} />
      <Text color={T.muted}>How long</Text>
      <Pill minutes={minutes} step={step} onChange={setMinutes} />
      <Box height={1} />
      <Text color={T.muted}>What was it</Text>
      <Box backgroundColor={T.element} paddingX={1} width={width - 6}>
        <Text wrap="truncate-start">
          <Typed value={draft.value} placeholder="e.g. pairing with Sam on the release" />
        </Text>
      </Box>
      <Box height={1} />
      <Box justifyContent="space-between" width={width - 6}>
        <Text color={T.faint}>tab project · ↑↓ time</Text>
        <Button label={`Add ${hm(minutes)}`} tone="primary" onClick={submit} />
      </Box>
    </Dialog>
  );
}
