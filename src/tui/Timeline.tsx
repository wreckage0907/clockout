import { Box, Text } from "ink";
import type { Config } from "../config/schema";
import { atLocalTime, localTime } from "../core/time";
import type { Day } from "../core/types";

/** One line of blocks across the day (█ work, ▓ meeting, ? unconfirmed, · unbilled, ░ gap). */
export function Timeline({ day, config, width }: { day: Day; config: Config; width: number }) {
  const tz = day.timezone;
  const [whFrom, whTo] = config.day.working_hours.split("-") as [string, string];
  const from = Math.min(
    atLocalTime(day.date, whFrom, tz).getTime(),
    ...day.blocks.map((b) => b.start.getTime()),
  );
  const to = Math.max(
    atLocalTime(day.date, whTo, tz).getTime(),
    ...day.blocks.map((b) => b.end.getTime()),
  );
  const cols = Math.max(20, width);
  const span = (to - from) / cols;

  const cells: { ch: string; color?: string; dim?: boolean }[] = [];
  for (let c = 0; c < cols; c++) {
    const t = from + (c + 0.5) * span;
    const hits = day.blocks.filter((b) => b.start.getTime() <= t && b.end.getTime() > t);
    const b = hits.find((x) => x.confirmed) ?? hits[0];
    if (!b) cells.push({ ch: "░", dim: true });
    else if (!b.confirmed) cells.push({ ch: "?", color: "yellow" });
    else if (!b.billable) cells.push({ ch: "·", dim: true });
    else if (b.kind === "meeting") cells.push({ ch: "▓", color: "magenta" });
    else cells.push({ ch: "█", color: b.kind === "review" ? "blue" : "cyan" });
  }

  // Hour labels at their column positions
  const labels = Array.from({ length: cols }, () => " ");
  const firstHour = Math.ceil(from / 3_600_000) * 3_600_000;
  for (let h = firstHour; h < to; h += 3_600_000) {
    const col = Math.round((h - from) / span);
    const label = localTime(new Date(h), tz).slice(0, 2);
    if (col + 1 < cols && labels[col] === " " && labels[col - 1] === " ") {
      labels[col] = label[0] ?? " ";
      labels[col + 1] = label[1] ?? " ";
    }
  }

  return (
    <Box flexDirection="column">
      <Text dimColor>{labels.join("")}</Text>
      <Text>
        {groupRuns(cells).map((run, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: runs are positional
          <Text key={i} color={run.color} dimColor={run.dim}>
            {run.text}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

function groupRuns(cells: { ch: string; color?: string; dim?: boolean }[]) {
  const runs: { text: string; color?: string; dim?: boolean }[] = [];
  for (const c of cells) {
    const last = runs.at(-1);
    if (last && last.color === c.color && last.dim === c.dim) last.text += c.ch;
    else
      runs.push({
        text: c.ch,
        ...(c.color ? { color: c.color } : {}),
        ...(c.dim ? { dim: true } : {}),
      });
  }
  return runs;
}
