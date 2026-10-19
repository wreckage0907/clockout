import { Box, Text, useInput } from "ink";
import { useState } from "react";
import { ACCENT } from "./shared";

const DOW = ["Mo", "Tu", "We", "Th", "Fr", "Sa", "Su"];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function iso(d: Date): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** Six week rows (Mon-start) covering the anchor's month. */
function monthGrid(anchor: Date): Date[] {
  const y = anchor.getUTCFullYear();
  const m = anchor.getUTCMonth();
  const first = new Date(Date.UTC(y, m, 1));
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: Date[] = [];
  const start = Date.UTC(y, m, 1 - lead, 12);
  for (let i = 0; i < 42; i++) cells.push(new Date(start + i * 86_400_000));
  return cells;
}

function monthLabel(anchor: Date): string {
  return anchor.toLocaleDateString("en", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * Khal-style day picker as an opencode-style overlay dialog: a mini month
 * where days with a draft are bright. Arrows move, enter opens, esc closes.
 */
export function DayPicker({
  anchor,
  hasData,
  onPick,
  onClose,
}: {
  /** Any date inside the month to show. */
  anchor: Date;
  /** True when the day already has a draft. */
  hasData: (d: Date) => boolean;
  onPick: (date: string) => void;
  onClose: () => void;
}) {
  const [sel, setSel] = useState(anchor.getTime());
  const cells = monthGrid(anchor);
  const move = (days: number) => {
    setSel((t) => {
      const next = new Date(t + days * 86_400_000);
      // Stay inside the month being shown.
      return next.getUTCMonth() === anchor.getUTCMonth() ? next.getTime() : new Date(t).getTime();
    });
  };

  useInput((ch, key) => {
    if (key.escape || ch === "q") return onClose();
    if (key.leftArrow) return move(-1);
    if (key.rightArrow) return move(1);
    if (key.upArrow) return move(-7);
    if (key.downArrow) return move(7);
    if (key.return) return onPick(iso(new Date(sel)));
  });

  const selDate = new Date(sel);
  const selHasData = hasData(selDate);
  const selLabel = selDate.toLocaleDateString("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={ACCENT}
      paddingX={2}
      flexShrink={0}
    >
      <Text>
        <Text bold>Pick a day</Text>
        <Text dimColor> · {monthLabel(anchor)}</Text>
      </Text>
      <Box height={1} />
      <Text dimColor>{DOW.map((d) => d.padEnd(3)).join("")}</Text>
      {[0, 1, 2, 3, 4, 5].map((w) => (
        <Text key={w}>
          {cells.slice(w * 7, w * 7 + 7).map((d) => {
            const inMonth = d.getUTCMonth() === anchor.getUTCMonth();
            const has = hasData(d);
            const isSel = d.getTime() === sel;
            const label = String(d.getUTCDate()).padStart(2, " ");
            const cell = `${inMonth ? label : "  "} `;
            if (isSel)
              return (
                <Text key={d.getTime()} inverse color={has ? "white" : "gray"}>
                  {cell}
                </Text>
              );
            return (
              <Text key={d.getTime()} dimColor={!inMonth || !has}>
                {cell}
              </Text>
            );
          })}
        </Text>
      ))}
      <Box height={1} />
      <Text>
        <Text bold>{selLabel}</Text>
        <Text dimColor>{selHasData ? " · has a draft" : " · empty — tell me what you did"}</Text>
      </Text>
      <Text dimColor>↑↓←→ move · enter open · esc back</Text>
    </Box>
  );
}
