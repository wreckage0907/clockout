import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { DayPicker } from "../tui/DayPicker";
import { ACCENT, InputBar } from "../tui/shared";
import { Wordmark } from "./shared";

const COMMANDS = [
  { name: "pick a day", hint: "fill in a previous day" },
  { name: "connect a source", hint: "calendar, agents, github" },
  { name: "open today", hint: "review and correct the draft" },
] as const;

/**
 * Design 1 — "home". A near-empty welcome: wordmark, one input bar, nothing else.
 * Navigation lives in the input itself: type "/" for commands (opencode style),
 * and "pick a day" opens a mini-month overlay (khal style).
 */
export function Home({
  width,
  height,
  date,
  onNavigate,
  onOpenDay,
}: {
  width: number;
  height: number;
  /** The demo day, as YYYY-MM-DD; anchors the picker's month. */
  date: string;
  onNavigate?: (section: "today" | "sources" | "chat") => void;
  onOpenDay?: (date: string) => void;
}) {
  const [input, setInput] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [cmdSel, setCmdSel] = useState(0);

  const menu = input.startsWith("/") && !picker;
  const query = input.slice(1).trim().toLowerCase();
  const filtered = COMMANDS.filter((c) => c.name.startsWith(query));
  const selIndex = Math.min(cmdSel, Math.max(0, filtered.length - 1));

  const runCommand = (name: string) => {
    setInput("");
    setCmdSel(0);
    if (name === "pick a day") setPicker(true);
    else if (name === "connect a source") onNavigate?.("sources");
    else if (name === "open today") onNavigate?.("today");
  };

  useInput((ch, key) => {
    if (picker) return; // the picker owns the keys
    if (key.escape) return setInput("");
    if (key.upArrow && menu) return setCmdSel((s) => Math.max(0, s - 1));
    if (key.downArrow && menu) return setCmdSel((s) => Math.min(filtered.length - 1, s + 1));
    if (key.return) {
      const text = input.trim();
      if (menu && filtered[selIndex]) return runCommand(filtered[selIndex].name);
      if (text) {
        setNote(`“${text}” — got it. In the real app, Clockout drafts your day from this.`);
        setInput("");
      }
      return;
    }
    if (key.backspace || key.delete) return setInput((v) => v.slice(0, -1));
    if (ch && !key.ctrl && !key.meta && !key.tab) {
      setInput((v) => v + ch.replace(/[\r\n]/g, " "));
      setNote(null);
    }
  });

  // Deterministic pretend history so the picker shows a lived-in month.
  const anchor = new Date(`${date}T12:00:00Z`);
  const pretendHours = (d: Date): number | null => {
    const dow = d.getUTCDay();
    if (dow === 0 || dow === 6) return null;
    const n = (d.getUTCDate() * 7) % 5;
    return n === 0 ? null : 3 + n;
  };

  const boxWidth = Math.min(76, Math.max(40, width - 12));
  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      alignItems="center"
      justifyContent="center"
    >
      {picker ? (
        <DayPicker
          anchor={anchor}
          hasData={(d) => pretendHours(d) !== null}
          onPick={(picked) => {
            setPicker(false);
            onOpenDay?.(picked);
          }}
          onClose={() => setPicker(false)}
        />
      ) : (
        <>
          <Wordmark />
          <Box height={2} />
          {menu ? (
            <Box flexDirection="column" width={boxWidth} paddingLeft={1}>
              {filtered.map((c, i) => (
                <Text key={c.name}>
                  <Text color={i === selIndex ? ACCENT : undefined}>
                    {i === selIndex ? "● " : "  "}
                  </Text>
                  <Text bold={i === selIndex}>{c.name}</Text>
                  <Text dimColor> — {c.hint}</Text>
                </Text>
              ))}
              {filtered.length === 0 ? <Text dimColor>no such command</Text> : null}
            </Box>
          ) : null}
          <InputBar
            value={input}
            width={boxWidth}
            placeholder="Say it, or / for commands"
            meta={menu ? "↑↓ choose · enter" : "enter to send"}
          />
          {note ? (
            <Box paddingTop={1} width={boxWidth}>
              <Text color={ACCENT} wrap="truncate-end">
                {note}
              </Text>
            </Box>
          ) : null}
        </>
      )}
    </Box>
  );
}
