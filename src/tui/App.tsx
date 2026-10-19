import { Box, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Correction } from "../ai/edits";
import type { OpenedDay } from "../collect";
import type { Config } from "../config/schema";
import { describeEdits } from "../core/edits";
import { addDays, formatDuration, localTime, minutesBetween } from "../core/time";
import { dayTotals, type Row, tableRows, timesheetRows } from "../core/timesheet";
import type { Day, EditOp, Question } from "../core/types";
import { formatHours, toMarkdown, toTsv } from "../export/formats";
import type { StoredDay } from "../store/json-store";
import { DayPicker } from "./DayPicker";
import { InputBar } from "./shared";

function isoDay(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export interface AppActions {
  load(date: string): Promise<OpenedDay>;
  /** null when no AI backend is configured. */
  parse: ((text: string, day: Day) => Promise<Correction>) | null;
  commit(
    stored: StoredDay,
    ops: EditOp[],
    text: string,
  ): Promise<{ stored: StoredDay; errors: string[] }>;
  undo(stored: StoredDay): Promise<StoredDay | null>;
  copy(text: string): Promise<void>;
  /** Dates with a saved day, for the picker; null when unknown. */
  savedDates: (() => Promise<string[]>) | null;
}

interface Proposal {
  text: string;
  ops: EditOp[];
  lines: string[];
  reply: string;
}

interface Command {
  name: string;
  hint: string;
  run: () => void;
}

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
  for (const a of ev.filter((x) => x.kind === "pr")) lines.push(`opened ${a.refs?.join(" ")}`);
  for (const a of ev.filter((x) => x.kind === "review" || x.kind === "review_comment"))
    lines.push(`reviewed ${a.refs?.join(" ")}`);
  const meeting = ev.find((a) => a.kind === "meeting");
  if (meeting) lines.push(`calendar: ${meeting.title}`);
  if (lines.length === 0) lines.push("added by you");
  return lines;
}

/** Questions grouped by the row they belong to. */
function questionsByRow(day: Day): Map<string, Question[]> {
  const map = new Map<string, Question[]>();
  for (const q of day.questions) {
    const id = q.blockId ?? q.gapId;
    if (!id) continue;
    const list = map.get(id) ?? [];
    list.push(q);
    map.set(id, list);
  }
  return map;
}

export function App({
  initialDate,
  config,
  actions,
  aiLabel,
}: {
  initialDate: string;
  config: Config;
  actions: AppActions;
  aiLabel: string | null;
}) {
  const { exit } = useApp();
  const { columns } = useWindowSize();
  const width = Math.max(60, Math.min(columns, 120));

  const [date, setDate] = useState(initialDate);
  const [stored, setStored] = useState<StoredDay | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>("Drafting your day…");
  const [input, setInput] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);
  const [picker, setPicker] = useState(false);
  const [cmdSel, setCmdSel] = useState(0);
  const [savedDates, setSavedDates] = useState<string[]>([]);

  useEffect(() => {
    if (!picker) return;
    actions
      .savedDates?.()
      .then((ds) => setSavedDates(ds))
      .catch(() => setSavedDates([]));
  }, [picker, actions]);

  useEffect(() => {
    let live = true;
    setBusy(aiLabel ? `Drafting ${date} (summaries by ${aiLabel})…` : `Drafting ${date}…`);
    actions
      .load(date)
      .then((opened) => {
        if (!live) return;
        setStored(opened.stored);
        setWarnings(opened.warnings);
        setSelected(0);
        setStatus(opened.kept ? "Showing your corrected day." : null);
      })
      .catch((err: Error) => live && setStatus(`Couldn't load ${date}: ${err.message}`))
      .finally(() => live && setBusy(null));
    return () => {
      live = false;
    };
  }, [date, actions, aiLabel]);

  const day = stored?.day;
  const rows = useMemo(() => (day ? tableRows(day) : []), [day]);

  const send = useCallback(
    async (text: string) => {
      if (!stored || !day) return;
      if (!actions.parse) {
        setStatus("Plain-word corrections need Claude Code. Set ai.backend in your config.");
        return;
      }
      setInput("");
      setBusy(
        `Thinking about “${text.length > 60 ? `${text.slice(0, 59)}…` : text}” (${aiLabel})…`,
      );
      try {
        const { ops, reply } = await actions.parse(text, day);
        const changes = ops.filter((o) => o.op !== "clarify");
        if (changes.length === 0) {
          setStatus(describeEdits(day, ops).join(" ") || reply || "No changes.");
        } else {
          setProposal({ text, ops, lines: describeEdits(day, ops), reply });
        }
      } catch (err) {
        setStatus((err as Error).message);
        setInput(text);
      } finally {
        setBusy(null);
      }
    },
    [stored, day, actions, aiLabel],
  );

  const accept = useCallback(async () => {
    if (!stored || !proposal) return;
    setBusy("Saving…");
    try {
      const result = await actions.commit(stored, proposal.ops, proposal.text);
      if (result.errors.length) {
        setStatus(`Couldn't apply that: ${result.errors.join(" ")}`);
        setInput(proposal.text);
      } else {
        setStored(result.stored);
        setStatus(`Saved. ${proposal.reply} /undo to undo.`.replace(/\s+/g, " ").trim());
      }
    } catch (err) {
      setStatus(`Couldn't save: ${(err as Error).message}`);
      setInput(proposal.text);
    } finally {
      setProposal(null);
      setBusy(null);
    }
  }, [stored, proposal, actions]);

  const undo = useCallback(async () => {
    if (!stored) return;
    try {
      const s = await actions.undo(stored);
      if (s) {
        setStored(s);
        setStatus("Undone.");
      } else setStatus("Nothing to undo.");
    } catch (err) {
      setStatus(`Couldn't undo: ${(err as Error).message}`);
    }
  }, [stored, actions]);

  const copy = useCallback(
    async (format: "tsv" | "md") => {
      if (!day) return;
      const sheet = timesheetRows(day, config);
      if (sheet.length === 0) {
        setStatus("Nothing to copy yet.");
        return;
      }
      try {
        await actions.copy(format === "tsv" ? toTsv(sheet) : toMarkdown(sheet));
        setStatus(
          `Copied ${sheet.length} row${sheet.length === 1 ? "" : "s"} (${format === "tsv" ? "tab-separated" : "Markdown"}).`,
        );
      } catch {
        setStatus("Couldn't reach the clipboard. Use `clockout export` instead.");
      }
    },
    [day, config, actions],
  );

  const commands: Command[] = useMemo(() => {
    const move = (days: number) => () => setDate((d) => addDays(d, days));
    return [
      { name: "pick a day", hint: "fill in a previous day", run: () => setPicker(true) },
      { name: "copy sheet", hint: "tab-separated, ready to paste", run: () => void copy("tsv") },
      { name: "copy as markdown", hint: "for notes and docs", run: () => void copy("md") },
      { name: "undo", hint: "the last correction", run: () => void undo() },
      { name: "previous day", hint: "", run: move(-1) },
      { name: "next day", hint: "", run: move(1) },
    ];
  }, [copy, undo]);

  usePaste(
    (text) => {
      // Dictation arrives as one paste; newlines never submit.
      if (picker) return;
      setInput(
        (v) =>
          `${v}${v && !v.endsWith(" ") ? " " : ""}${text.replace(/\s*[\r\n]+\s*/g, " ").trim()}`,
      );
      setStatus(null);
    },
    { isActive: !busy && !proposal },
  );

  const menu = input.startsWith("/") && !picker && !proposal && !busy;
  const query = input.slice(1).trim().toLowerCase();
  const filtered = commands.filter((c) => c.name.startsWith(query));
  const selIndex = Math.min(cmdSel, Math.max(0, filtered.length - 1));

  useInput((ch, key) => {
    if (picker) return; // the picker owns the keys
    if (busy) return;
    if (proposal) {
      if (ch === "y" || key.return) void accept();
      else if (ch === "n" || key.escape) {
        setProposal(null);
        setInput(proposal.text);
        setStatus("Discarded. Edit your words and press Enter, or Esc to clear.");
      }
      return;
    }
    if (key.upArrow && menu) return setCmdSel((s) => Math.max(0, s - 1));
    if (key.downArrow && menu) return setCmdSel((s) => Math.min(filtered.length - 1, s + 1));
    if (key.escape) return setInput("");
    if (key.return) {
      if (menu && filtered[selIndex]) {
        const cmd = filtered[selIndex];
        setInput("");
        setCmdSel(0);
        cmd.run();
        return;
      }
      const text = input.trim();
      if (text) void send(text);
      return;
    }
    if (menu) {
      if (key.backspace || key.delete) return setInput((v) => v.slice(0, -1));
      if (ch && !key.ctrl && !key.meta && !key.tab)
        return setInput((v) => v + ch.replace(/[\r\n]/g, " "));
      return;
    }
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSelected((s) => Math.max(0, Math.min(rows.length - 1, s + 1)));
    if (key.pageUp) return setDate((d) => addDays(d, -1));
    if (key.pageDown) return setDate((d) => addDays(d, 1));
    if (key.backspace || key.delete) return setInput((v) => v.slice(0, -1));
    // Shortcuts use Ctrl so typed text never triggers them.
    if (key.ctrl) {
      if (ch === "u") return setInput("");
      if (ch === "y") return void copy("tsv");
      if (ch === "t") return void copy("md");
      if (ch === "z") return void undo();
      if (ch === "d") return exit();
      return;
    }
    if (ch && !key.meta && !key.tab) {
      setInput((v) => v + ch.replace(/[\r\n]/g, " "));
      setStatus(null);
    }
  });

  // Keep the selection on a real row when edits or undo shrink the list.
  useEffect(() => {
    setSelected((s) => Math.max(0, Math.min(s, rows.length - 1)));
  }, [rows.length]);

  const totals = day ? dayTotals(day, config) : null;
  const questions = useMemo(
    () => (day ? questionsByRow(day) : new Map<string, Question[]>()),
    [day],
  );

  return (
    <Box flexDirection="column" width={width}>
      <Box paddingLeft={2} paddingTop={1} flexShrink={0}>
        <Text dimColor>
          <Text color="blue">◷ </Text>
          <Text bold>clockout</Text>
          <Text dimColor>
            {" · "}
            {weekday(date)} · {stored?.edits.length ? "corrected" : "draft"}
            {totals ? ` · ${formatHours(totals.hours)}h` : ""}
            {totals?.questions ? ` · ${totals.questions} questions` : ""}
            {aiLabel ? ` · AI: ${aiLabel}` : ""}
          </Text>
        </Text>
      </Box>

      {day ? (
        <Box flexDirection="column" paddingLeft={2} flexShrink={0}>
          {rows.map((row, i) => {
            const isSel = i === selected;
            if (row.kind === "gap") {
              const gapQ = questions.get(row.gap.id)?.[0]?.text;
              return (
                <Box key={row.gap.id} flexDirection="column">
                  <Box width={width - 4} paddingLeft={isSel ? 0 : 1}>
                    <Box width={1}>
                      <Text color={isSel ? "blue" : undefined}>{isSel ? "▍" : " "}</Text>
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
                    <Box width={width - 21}>
                      <Text dimColor wrap="truncate-end">
                        {gapQ ?? "gap · what filled it?"}
                      </Text>
                    </Box>
                  </Box>
                  {isSel ? (
                    <Box paddingLeft={4} width={width - 4}>
                      <Text dimColor wrap="truncate-end">
                        no activity here — say “{row.gap.id} was lunch”
                      </Text>
                    </Box>
                  ) : null}
                </Box>
              );
            }
            const b = row.block;
            const qs = questions.get(b.id) ?? [];
            return (
              <Box key={b.id} flexDirection="column">
                <Box width={width - 4} paddingLeft={isSel ? 0 : 1}>
                  <Box width={1}>
                    <Text color={isSel ? "blue" : undefined}>{isSel ? "▍" : " "}</Text>
                  </Box>
                  <Box width={2}>
                    <Text color="yellow">{qs.length ? "? " : "  "}</Text>
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
                  <Box width={1} flexShrink={0}>
                    <Text> </Text>
                  </Box>
                  <Box width={width - 50}>
                    <Text dimColor={!b.confirmed} wrap="truncate-end">
                      {b.summary}
                    </Text>
                  </Box>
                  <Box width={1}>
                    <Text> </Text>
                  </Box>
                  <Box width={5}>
                    <Text bold={isSel}>
                      {formatDuration(minutesBetween(b.start, b.end)).padStart(5)}
                    </Text>
                  </Box>
                </Box>
                {isSel || qs.length ? (
                  <Box flexDirection="column" paddingLeft={4} width={width - 4}>
                    {qs.slice(0, 2).map((q) => (
                      <Text key={q.id} color="yellow" wrap="truncate-end">
                        {q.text}
                      </Text>
                    ))}
                    {isSel
                      ? evidenceLines(row)
                          .slice(0, 2)
                          .map((line) => (
                            <Text key={line} dimColor wrap="truncate-end">
                              {line}
                            </Text>
                          ))
                      : null}
                  </Box>
                ) : null}
              </Box>
            );
          })}
        </Box>
      ) : (
        <Box height={6} />
      )}

      <Box flexGrow={1} flexShrink={0} />

      {proposal ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="green"
          paddingX={1}
          marginLeft={2}
          flexShrink={0}
        >
          <Text color="green" bold>
            Proposed changes
          </Text>
          {proposal.lines.map((l) => (
            <Text key={l}>• {l}</Text>
          ))}
          <Text dimColor>y / Enter to apply · n / Esc to discard</Text>
        </Box>
      ) : null}

      {menu ? (
        <Box flexDirection="column" paddingLeft={3} flexShrink={0}>
          {filtered.map((c, i) => (
            <Text key={c.name}>
              <Text color={i === selIndex ? "blue" : undefined}>
                {i === selIndex ? "● " : "  "}
              </Text>
              <Text bold={i === selIndex}>{c.name}</Text>
              {c.hint ? <Text dimColor> — {c.hint}</Text> : null}
            </Text>
          ))}
          {filtered.length === 0 ? <Text dimColor>no such command</Text> : null}
        </Box>
      ) : null}

      {picker && day ? (
        <Box marginLeft={2} flexShrink={0}>
          <DayPicker
            anchor={new Date(`${date}T12:00:00Z`)}
            hasData={(d) => savedDates.includes(isoDay(d))}
            onPick={(picked) => {
              setPicker(false);
              setDate(picked);
            }}
            onClose={() => setPicker(false)}
          />
        </Box>
      ) : null}

      <Box marginLeft={2} marginBottom={picker ? 0 : 1} flexShrink={0}>
        <InputBar
          value={busy ? "" : input}
          width={Math.min(76, width - 4)}
          placeholder={busy ?? (menu ? "" : "Say it, or / for commands")}
          meta={busy ?? (menu ? "↑↓ choose · enter" : "enter to send")}
        />
      </Box>
      {status && !picker ? (
        <Box paddingLeft={3} marginBottom={1}>
          <Text dimColor wrap="truncate-end">
            {status}
          </Text>
        </Box>
      ) : null}
      {warnings.length ? (
        <Box paddingLeft={3}>
          <Text color="yellow">⚠ {warnings.join(" · ")}</Text>
        </Box>
      ) : null}
    </Box>
  );
}
