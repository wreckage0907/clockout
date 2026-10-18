import { Box, Text } from "ink";
import { prNumber } from "../core/summarize";
import { localTime } from "../core/time";
import type { Day } from "../core/types";
import type { Row } from "./BlockTable";

export function Questions({ day, width }: { day: Day; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} width={width}>
      <Text color="yellow" bold>
        Questions
      </Text>
      {day.questions.length === 0 ? (
        <Text dimColor>None. Looks complete.</Text>
      ) : (
        day.questions.slice(0, 5).map((q) => (
          <Text key={q.id} wrap="truncate-end">
            {q.id.slice(1)}. {q.text}
          </Text>
        ))
      )}
      {day.questions.length > 5 ? <Text dimColor>+{day.questions.length - 5} more</Text> : null}
    </Box>
  );
}

/** What a selected block is based on, so you can trust or fix it. */
export function Evidence({ row, day, width }: { row: Row | undefined; day: Day; width: number }) {
  const lines: string[] = [];
  let title = "Evidence";
  if (row?.kind === "gap") {
    title = "Gap";
    lines.push(
      `${localTime(row.gap.start, day.timezone)}–${localTime(row.gap.end, day.timezone)} has no activity.`,
    );
    lines.push(`Say what it was, e.g. "${row.gap.id} was lunch".`);
  } else if (row?.kind === "block") {
    const b = row.block;
    title = `${b.id} · evidence`;
    const ev = b.evidence;
    const sessions = new Set(ev.filter((a) => a.sessionId).map((a) => a.sessionId));
    const prompts = ev.filter((a) => a.kind === "prompt").length;
    if (prompts)
      lines.push(
        `${prompts} prompt${prompts === 1 ? "" : "s"} in ${sessions.size} Claude Code session${sessions.size === 1 ? "" : "s"}`,
      );
    for (const a of ev.filter((x) => x.kind === "pr"))
      lines.push(`Opened PR #${prNumber(a)} ${a.title ?? ""}`);
    const reviewed = new Set(
      ev
        .filter((x) => x.kind === "review" || x.kind === "review_comment")
        .map((a) => `#${prNumber(a)} ${a.title ?? ""}`),
    );
    for (const r of reviewed) lines.push(`Reviewed PR ${r}`);
    const branches = [...new Set(ev.map((a) => a.branch).filter(Boolean))];
    if (branches.length) lines.push(`Branch ${branches.join(", ")}`);
    const meeting = ev.find((a) => a.kind === "meeting");
    if (meeting) {
      lines.push(`Calendar: ${meeting.title}`);
      lines.push(
        `Your RSVP: ${meeting.attendance ?? "unknown"}${meeting.attendees ? ` · ${meeting.attendees.length} others` : ""}`,
      );
    }
    if (ev.length === 0) lines.push("Added by you.");
  }
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1} width={width}>
      <Text bold>{title}</Text>
      {lines.length === 0 ? <Text dimColor>Select a row.</Text> : null}
      {lines.slice(0, 5).map((l) => (
        <Text key={l} wrap="truncate-end">
          {l}
        </Text>
      ))}
    </Box>
  );
}
