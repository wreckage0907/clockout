import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Config } from "../config/schema";
import { timesheetRows } from "../core/timesheet";
import type { Day } from "../core/types";
import { formatHours } from "../export/formats";
import { ACCENT, InputBar } from "../tui/shared";

interface Msg {
  who: "clockout" | "you";
  text: string;
  sheet?: boolean;
}

function firstName(config: Config): string {
  return config.me.name.split(" ")[0] ?? config.me.name;
}

function SheetCard({ day, config }: { day: Day; config: Config }) {
  const rows = timesheetRows(day, config);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      alignSelf="flex-start"
      marginTop={1}
      marginBottom={1}
    >
      {rows.map((r) => (
        <Text key={`${r.project}-${r.task}`} wrap="truncate-end">
          <Text color={ACCENT}>{r.project}</Text>
          {` ${r.description}`}
          <Text> </Text>
          <Text bold>{formatHours(r.hours)}h</Text>
        </Text>
      ))}
      {day.questions.length > 0 ? (
        <Text color="yellow" wrap="truncate-end">
          {day.questions.length} questions — just tell me what happened.
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * Design 4 — "chat". There is no dashboard: the timesheet is a message.
 * You correct it like you'd correct a person, and the sheet updates in place.
 */
export function Chat({
  day,
  config,
  width,
  height,
}: {
  day: Day;
  config: Config;
  width: number;
  height: number;
}) {
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<Msg[]>(() => [
    {
      who: "clockout",
      text: `Morning, ${firstName(config)}. Here's Friday, drafted from your sessions, PRs and calendar.`,
      sheet: true,
    },
    {
      who: "clockout",
      text: "Two things need a word from you: the gap after lunch, and the 3pm design sync you never confirmed.",
    },
  ]);

  useInput((ch, key) => {
    if (key.escape) return setInput("");
    if (key.return) {
      const text = input.trim();
      if (text) {
        setMsgs((m) => [
          ...m,
          { who: "you", text },
          {
            who: "clockout",
            text: "Noted — I'd apply that to the draft and show you the diff. (prototype)",
          },
        ]);
        setInput("");
      }
      return;
    }
    if (key.backspace || key.delete) return setInput((v) => v.slice(0, -1));
    if (ch && !key.ctrl && !key.meta && !key.tab) {
      setInput((v) => v + ch.replace(/[\r\n]/g, " "));
    }
  });

  // Rough scroll: show the tail of the conversation.
  const visible = msgs.slice(-Math.max(4, Math.floor(height / 3)));

  return (
    <Box flexDirection="column" width={width} height={height} justifyContent="space-between">
      <Box flexDirection="column" paddingLeft={2} paddingTop={1}>
        {visible.map((m, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: messages are append-only
          <Box key={i} flexDirection="column" paddingLeft={m.who === "you" ? 4 : 0}>
            {m.sheet ? <SheetCard day={day} config={config} /> : null}
            {m.text ? (
              <Text wrap="truncate-end">
                <Text dimColor>{m.who === "you" ? "you · " : "clockout · "}</Text>
                {m.text}
              </Text>
            ) : null}
          </Box>
        ))}
        <Box height={1} />
      </Box>
      <InputBar
        value={input}
        width={Math.min(76, width - 4)}
        placeholder="Reply… “I skipped the design sync”"
        meta="enter to send"
      />
    </Box>
  );
}
