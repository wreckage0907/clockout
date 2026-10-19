import { Box, Text, useInput, useWindowSize } from "ink";
import { useState } from "react";
import type { Config } from "../config/schema";
import type { Day } from "../core/types";
import { Hint } from "../tui/shared";
import { Chat } from "./Chat";
import { Home } from "./Home";
import { Review } from "./Review";
import { Sources } from "./Sources";

const SECTIONS = ["home", "today", "sources", "chat"] as const;
type Section = (typeof SECTIONS)[number];

function isSection(v: string): v is Section {
  return (SECTIONS as readonly string[]).includes(v);
}

/**
 * Wraps the four prototype designs and lets you flip between them with tab,
 * so they can be compared live on the same demo day. The chrome itself stays
 * out of the designs — each design owns its screen.
 */
export function Designs({
  day,
  config,
  date,
  initial,
}: {
  day: Day | null;
  config: Config;
  date: string;
  initial?: string;
}) {
  const { columns, rows: height } = useWindowSize();
  const width = Math.max(60, Math.min(columns, 120));
  const [current, setCurrent] = useState<Section>(
    initial !== undefined && isSection(initial) ? initial : "home",
  );
  const [viewDate, setDate] = useState<string>(date);

  useInput((_ch, key) => {
    if (!key.tab) return;
    const step = key.shift ? SECTIONS.length - 1 : 1;
    const idx = SECTIONS.indexOf(current);
    setCurrent(SECTIONS[(idx + step) % SECTIONS.length] as Section);
  });

  // The picker can open a different day; the prototype clones the sample day.
  const viewDay = day && viewDate !== date ? { ...day, date: viewDate } : day;
  const bodyH = height - 1; // hint line
  let body: React.ReactNode;
  switch (current) {
    case "today":
      body = viewDay ? (
        <Review day={viewDay} config={config} width={width} height={bodyH} />
      ) : (
        <Text dimColor> loading…</Text>
      );
      break;
    case "sources":
      body = <Sources width={width} height={bodyH} />;
      break;
    case "chat":
      body = viewDay ? (
        <Chat day={viewDay} config={config} width={width} height={bodyH} />
      ) : (
        <Text dimColor> loading…</Text>
      );
      break;
    default:
      body = (
        <Home
          width={width}
          height={bodyH}
          date={date}
          onNavigate={(s) => setCurrent(s)}
          onOpenDay={(picked) => {
            setDate(picked);
            setCurrent("today");
          }}
        />
      );
  }

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box flexGrow={1} flexDirection="column" overflow="hidden">
        {body}
      </Box>
      <Hint
        text={
          current === "home"
            ? `${viewDate} · / for commands · tab to compare designs · ctrl+c quit`
            : `${viewDate} · tab to compare designs · ctrl+c quit`
        }
      />
    </Box>
  );
}
