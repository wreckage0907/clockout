import { Box, Text, useInput } from "ink";
import { useState } from "react";
import type { Config } from "../config/schema";
import { prNumber } from "../core/summarize";
import { formatDuration, localTime, minutesBetween } from "../core/time";
import { dayTotals, type Row, tableRows } from "../core/timesheet";
import type { Day } from "../core/types";
import { formatHours } from "../export/formats";
import { ACCENT, InputBar } from "../tui/shared";

// marker(1) + question(2) + time(12) + project(19) + spacer(1) + hours(5) + spacer(1)
const ROW_FIXED = 41;

function weekday(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

function evidenceLines(row: Row | undefined): string[] {
  if (row?.kind !== "block") return [];
  const ev = row.block.evidence;
  const lines: string[] = [];
  const sessions = new Set(ev.filter((a) => a.sessionId).map((a) => a.sessionId));
  const prompts = ev.filter((a) => a.kind === "prompt").length;
  if (prompts)
    lines.push(
      `${prompts} prompt${prompts === 1 ? "" : "s"} in ${sessions.size} session${sessions.size === 1 ? "" : "s"}`,
    );
  for (const a of ev.filter((x) => x.kind === "pr")) lines.push(`opened PR #${prNumber(a)}`);
  for (const a of ev.filter((x) => x.kind === "review" || x.kind === "review_comment"))
    lines.push(`reviewed PR #${prNumber(a)}`);
  const meeting = ev.find((a) => a.kind === "meeting");
  if (meeting) lines.push(`calendar: ${meeting.title} · rsvp ${meeting.attendance ?? "unknown"}`);
  if (lines.length === 0) lines.push("added by you");
  return lines;
}

/**
 * Design 3 — "today". The review screen, calm edition:
 * no ASCII timeline, no column soup, one dim hint line. Times, project,
 * one sentence, hours. Gaps read as a question, not a wall of ░.
 */
export function Review({
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
  const rows = tableRows(day);
  const [sel, setSel] = useState(0);
  const [input, setInput] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const totals = dayTotals(day, config);
  const questionBlocks = new Set(day.questions.map((q) => q.blockId).filter(Boolean));
  const listWidth = Math.min(width - 4, 106);
  const summaryWidth = Math.max(12, listWidth - ROW_FIXED - 1);
  useInput((ch, key) => {
    if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSel((s) => Math.min(rows.length - 1, s + 1));
    if (key.escape) return setInput("");
    if (key.return) {
      const text = input.trim();
      if (text) {
        setNote(`“${text}” — in the real app, this proposes edits for you to accept.`);
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

  const dur = (b: { start: Date; end: Date }) =>
    formatDuration(minutesBetween(b.start, b.end)).padStart(5);

  return (
    <Box flexDirection="column" width={width} height={height} justifyContent="space-between">
      <Box flexDirection="column" paddingLeft={2} paddingTop={1} flexShrink={0}>
        <Text dimColor>
          {" "}
          {weekday(day.date)} · draft · {formatHours(totals.hours)}h
          {totals.questions ? ` · ${totals.questions} questions` : ""}
        </Text>
        {rows.map((row, i) => {
          const isSel = i === sel;
          const selectedRow = rows[sel];
          const evidence = isSel ? evidenceLines(selectedRow) : [];
          if (row.kind === "gap") {
            return (
              <Box key={row.gap.id} flexDirection="column">
                <Box width={listWidth} paddingLeft={isSel ? 0 : 1}>
                  <Box width={1}>
                    <Text color={isSel ? ACCENT : undefined}>{isSel ? "▍" : " "}</Text>
                  </Box>
                  <Box width={2}>
                    <Text> </Text>
                  </Box>
                  <Box width={12}>
                    <Text dimColor>
                      {localTime(row.gap.start, day.timezone)}–
                      {localTime(row.gap.end, day.timezone)}
                    </Text>
                  </Box>
                  <Box width={summaryWidth + 1}>
                    <Text dimColor wrap="truncate-end">
                      gap · what filled it?
                    </Text>
                  </Box>
                </Box>
                {evidence.length > 0 ? (
                  <Box paddingLeft={4} width={listWidth}>
                    <Text dimColor wrap="truncate-end">
                      no activity here — say “{row.gap.id} was lunch”
                    </Text>
                  </Box>
                ) : null}
              </Box>
            );
          }
          const b = row.block;
          const questioned = questionBlocks.has(b.id);
          return (
            <Box key={b.id} flexDirection="column">
              <Box width={listWidth} paddingLeft={isSel ? 0 : 1}>
                <Box width={1}>
                  <Text color={isSel ? ACCENT : undefined}>{isSel ? "▍" : " "}</Text>
                </Box>
                <Box width={2}>
                  <Text color="yellow">{questioned ? "? " : "  "}</Text>
                </Box>
                <Box width={12}>
                  <Text>
                    {localTime(b.start, day.timezone)}–{localTime(b.end, day.timezone)}
                  </Text>
                </Box>
                <Box width={19}>
                  <Text color={b.kind === "meeting" ? "magenta" : undefined} wrap="truncate-end">
                    {b.project}
                  </Text>
                </Box>
                <Box width={1}>
                  <Text> </Text>
                </Box>
                <Box width={summaryWidth}>
                  <Text dimColor={!b.confirmed} wrap="truncate-end">
                    {b.summary}
                  </Text>
                </Box>
                <Box width={1}>
                  <Text> </Text>
                </Box>
                <Box width={5}>
                  <Text bold={isSel}>{dur(b)}</Text>
                </Box>
              </Box>
              {evidence.slice(0, 2).map((line) => (
                <Box key={line} paddingLeft={4} width={listWidth}>
                  <Text dimColor wrap="truncate-end">
                    {line}
                  </Text>
                </Box>
              ))}
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column" paddingBottom={0}>
        {note ? (
          <Box marginBottom={1} paddingLeft={2}>
            <Text color={ACCENT}>{note}</Text>
          </Box>
        ) : null}
        <Box paddingLeft={2}>
          <InputBar
            value={input}
            width={Math.min(76, width - 6)}
            placeholder="Say what to change… “the gap after lunch was lunch”"
            meta={note ? undefined : "enter to send"}
          />
        </Box>
      </Box>
    </Box>
  );
}
