import { Box, Text } from "ink";
import type { Config } from "../config/schema";
import { formatDuration, localTime, minutesBetween } from "../core/time";
import { blockHours } from "../core/timesheet";
import type { Block, Day, Gap } from "../core/types";
import { formatHours } from "../export/formats";

export type Row = { kind: "block"; block: Block } | { kind: "gap"; gap: Gap };

export function tableRows(day: Day): Row[] {
  return [
    ...day.blocks.map((block) => ({ kind: "block" as const, block })),
    ...day.gaps.map((gap) => ({ kind: "gap" as const, gap })),
  ].sort((a, b) => start(a) - start(b));
}

function start(r: Row): number {
  return (r.kind === "block" ? r.block.start : r.gap.start).getTime();
}

export function BlockTable({
  day,
  config,
  rows,
  selected,
  width,
  height,
}: {
  day: Day;
  config: Config;
  rows: Row[];
  selected: number;
  width: number;
  height: number;
}) {
  const tz = day.timezone;
  const t = (d: Date) => localTime(d, tz);
  const projectWidth = Math.min(22, Math.max(8, ...day.blocks.map((b) => b.project.length)));
  const summaryWidth = Math.max(10, width - (4 + 5 + 12 + 6 + 7 + projectWidth + 2));
  const visible = Math.max(3, height);
  const first = Math.min(
    Math.max(0, selected - Math.floor(visible / 2)),
    Math.max(0, rows.length - visible),
  );
  // Columns: cursor+mark (4) · id (5) · time (12) · duration (6) · hours (7) · project · summary
  const line = (
    lead: string,
    id: string,
    time: string,
    dur: string,
    hours: string,
    project: string,
    rest: string,
  ) =>
    `${lead.padEnd(4)}${id.padEnd(5)}${time.padEnd(12)}${dur.padEnd(6)}${hours.padEnd(7)}${project.padEnd(projectWidth)}  ${rest}`;
  const clip = (text: string) =>
    text.length > summaryWidth ? `${text.slice(0, summaryWidth - 1)}…` : text;

  return (
    <Box flexDirection="column">
      <Text dimColor>{line("", "#", "TIME", "DUR", "HOURS", "PROJECT", "SUMMARY")}</Text>
      {rows.slice(first, first + visible).map((r, i) => {
        const isSel = first + i === selected;
        const cursor = isSel ? "›" : " ";
        if (r.kind === "gap") {
          const g = r.gap;
          return (
            <Text key={`g-${g.id}`} dimColor={!isSel} color={isSel ? "cyan" : undefined}>
              {line(
                `${cursor} ░`,
                "",
                `${t(g.start)}–${t(g.end)}`,
                formatDuration(minutesBetween(g.start, g.end)),
                "",
                "",
                "── gap ──",
              )}
            </Text>
          );
        }
        const b = r.block;
        const mark = !b.confirmed ? "?" : !b.billable ? "·" : " ";
        const hours = b.confirmed && b.billable ? `${formatHours(blockHours(b, config))}h` : "";
        const task = b.task !== config.tasks.work && b.task !== b.project ? ` · ${b.task}` : "";
        return (
          <Text
            key={b.id}
            color={isSel ? "cyan" : !b.confirmed ? "yellow" : undefined}
            dimColor={!isSel && b.confirmed && !b.billable}
            bold={isSel}
          >
            {line(
              `${cursor} ${mark}`,
              b.id,
              `${t(b.start)}–${t(b.end)}`,
              formatDuration(minutesBetween(b.start, b.end)),
              hours,
              b.project.slice(0, projectWidth),
              clip(`${b.summary}${task}`),
            )}
          </Text>
        );
      })}
      {rows.length > visible ? (
        <Text
          dimColor
        >{`    ${first + 1}–${Math.min(rows.length, first + visible)} of ${rows.length}`}</Text>
      ) : null}
    </Box>
  );
}
