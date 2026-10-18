import { Box, Text, useApp, useInput, usePaste, useWindowSize } from "ink";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { Correction } from "../ai/edits";
import type { OpenedDay } from "../collect";
import type { Config } from "../config/schema";
import { describeEdits } from "../core/edits";
import { addDays } from "../core/time";
import { dayTotals, timesheetRows } from "../core/timesheet";
import type { Day, EditOp } from "../core/types";
import { formatHours, toMarkdown, toTsv } from "../export/formats";
import type { StoredDay } from "../store/json-store";
import { BlockTable, tableRows } from "./BlockTable";
import { Evidence, Questions } from "./Panels";
import { SayIt } from "./SayIt";
import { Timeline } from "./Timeline";

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
}

interface Proposal {
  text: string;
  ops: EditOp[];
  lines: string[];
  reply: string;
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
  const { columns, rows: height } = useWindowSize();
  const width = Math.max(60, Math.min(columns, 140));

  const [date, setDate] = useState(initialDate);
  const [stored, setStored] = useState<StoredDay | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>("Drafting your day…");
  const [input, setInput] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [selected, setSelected] = useState(0);

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
        setStatus(`Saved. ${proposal.reply} Ctrl+Z to undo.`.replace(/\s+/g, " ").trim());
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
          `Copied ${sheet.length} row${sheet.length === 1 ? "" : "s"} (${format === "tsv" ? "tab-separated: date, project, task, hours, description" : "Markdown"}).`,
        );
      } catch {
        setStatus("Couldn't reach the clipboard. Use `clockout export` instead.");
      }
    },
    [day, config, actions],
  );

  usePaste(
    (text) => {
      // Dictation arrives as one paste; newlines never submit.
      setInput(
        (v) =>
          `${v}${v && !v.endsWith(" ") ? " " : ""}${text.replace(/\s*[\r\n]+\s*/g, " ").trim()}`,
      );
      setStatus(null);
    },
    { isActive: !busy && !proposal },
  );

  useInput((ch, key) => {
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
    if (key.upArrow) return setSelected((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSelected((s) => Math.max(0, Math.min(rows.length - 1, s + 1)));
    if (key.pageUp) return setDate((d) => addDays(d, -1));
    if (key.pageDown) return setDate((d) => addDays(d, 1));
    if (key.escape) return setInput("");
    if (key.return) {
      const text = input.trim();
      if (text) void send(text);
      return;
    }
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
  const fixed =
    1 + 2 + 1 + 9 + 5 + 2 + (proposal ? proposal.lines.length + 3 : 0) + (warnings.length ? 1 : 0);
  const tableHeight = Math.max(4, height - fixed);
  const narrow = width < 100;
  const half = narrow ? width : Math.floor(width / 2);
  const weekday = new Date(`${date}T12:00:00Z`).toLocaleDateString("en", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });

  return (
    <Box flexDirection="column" width={width}>
      <Box justifyContent="space-between">
        <Text>
          <Text color="cyan" bold>
            clockout
          </Text>
          <Text> · {weekday} · </Text>
          <Text dimColor>{stored?.edits.length ? "CORRECTED" : "DRAFT"}</Text>
        </Text>
        <Text>
          {totals ? <Text bold>{formatHours(totals.hours)}h</Text> : null}
          {totals?.questions ? (
            <Text color="yellow">
              {" "}
              · {totals.questions} question{totals.questions === 1 ? "" : "s"}
            </Text>
          ) : null}
          <Text dimColor> · AI: {aiLabel ?? "off"}</Text>
        </Text>
      </Box>

      {day ? (
        <>
          <Timeline day={day} config={config} width={width} />
          <BlockTable
            day={day}
            config={config}
            rows={rows}
            selected={selected}
            width={width}
            height={tableHeight}
          />
          <Box flexDirection={narrow ? "column" : "row"}>
            <Questions day={day} width={half} />
            <Evidence row={rows[selected]} day={day} width={half} />
          </Box>
        </>
      ) : (
        <Box height={tableHeight + 11} />
      )}

      {proposal ? (
        <Box
          flexDirection="column"
          borderStyle="round"
          borderColor="green"
          paddingX={1}
          width={width}
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

      <SayIt value={input} busy={busy} status={status} width={width} />
      {status && input !== "" ? <Text dimColor>{status}</Text> : null}
      <Text dimColor>
        ↑↓ select · Enter send · Ctrl+Y copy · Ctrl+T markdown · Ctrl+Z undo · PgUp/PgDn day ·
        Ctrl+C quit
      </Text>
      {warnings.length ? <Text color="yellow">⚠ {warnings.join(" · ")}</Text> : null}
    </Box>
  );
}
