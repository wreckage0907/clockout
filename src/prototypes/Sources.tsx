import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { ACCENT } from "../tui/shared";

interface Card {
  id: string;
  title: string;
  detail: string;
  /** "on" = connected/found, "off" = needs action, "none" = nothing to do. */
  state: "on" | "off" | "none";
  /** Enter/space toggles it (prototype: pretend). */
  toggleable?: boolean;
}

const CARDS: Card[] = [
  {
    id: "calendar",
    title: "Google Calendar",
    detail: "meetings you kept, from your RSVPs",
    state: "off",
    toggleable: true,
  },
  {
    id: "claude",
    title: "Claude Code",
    detail: "4 sessions on Friday, found automatically",
    state: "on",
  },
  {
    id: "github",
    title: "GitHub",
    detail: "connected · 2 PRs and a review on Friday",
    state: "on",
  },
  {
    id: "agents",
    title: "More agents",
    detail: "Codex · OpenCode · Pi — pick a default",
    state: "none",
  },
];

const CARD_WIDTH = 52;

/**
 * Design 2 — "sources". Setup as cards you can pick, not a wizard:
 * what's connected, what isn't, and what to do next.
 */
export function Sources({ width, height }: { width: number; height: number }) {
  const [sel, setSel] = useState(0);
  const [onIds, setOnIds] = useState<string[]>(() =>
    CARDS.filter((c) => c.state === "on").map((c) => c.id),
  );
  const [note, setNote] = useState<string | null>(null);

  const toggle = (card: Card) => {
    if (!card.toggleable) {
      setNote(`${card.title}: not wired up in this prototype.`);
      return;
    }
    const wasOn = onIds.includes(card.id);
    setOnIds((ids) => (wasOn ? ids.filter((id) => id !== card.id) : [...ids, card.id]));
    setNote(`${card.title} ${wasOn ? "disconnected" : "connected"} (pretend).`);
  };

  useInput((ch, key) => {
    if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSel((s) => Math.min(CARDS.length - 1, s + 1));
    if (key.return || (ch === " " && !key.ctrl)) {
      const card = CARDS[sel];
      if (card) toggle(card);
    }
  });

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      alignItems="center"
      justifyContent="center"
    >
      <Box flexDirection="column" width={CARD_WIDTH + 8} flexShrink={0}>
        <Text dimColor> </Text>
        <Text>
          <Text bold>Sources</Text>
          <Text dimColor> · what your timesheet is built from</Text>
        </Text>
        <Box height={1} />
        {CARDS.map((card, i) => {
          const isOn = onIds.includes(card.id);
          const isSelected = i === sel;
          return (
            <Box
              key={card.id}
              borderStyle="round"
              borderColor={isSelected ? ACCENT : undefined}
              paddingLeft={1}
              paddingRight={1}
              width={CARD_WIDTH}
              marginLeft={isSelected ? 0 : 4}
              marginBottom={1}
              flexShrink={0}
            >
              <Box justifyContent="space-between" width={CARD_WIDTH - 4}>
                <Box flexDirection="column">
                  <Text bold={isSelected} color={isSelected ? ACCENT : undefined}>
                    {card.title}
                  </Text>
                  <Text dimColor>{card.detail}</Text>
                </Box>
                {card.state === "none" ? (
                  <Text dimColor>›</Text>
                ) : (
                  <Text color={isOn ? "green" : "yellow"}>{isOn ? "● on" : "○ connect"}</Text>
                )}
              </Box>
            </Box>
          );
        })}
        <Box height={1} />
        {note ? (
          <Text color={ACCENT}>{note}</Text>
        ) : (
          <Text dimColor>↑↓ choose · enter to connect</Text>
        )}
      </Box>
    </Box>
  );
}
