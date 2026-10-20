import { Box, Text, useInput } from "ink";
import { type ReactNode, useRef, useState } from "react";
import { type Config, durationMinutes } from "../config/schema";
import { computeGaps } from "../core/blocks";
import type { Day } from "../core/types";
import { Clickable } from "../tui/clickable";
import { hm, projectColor, T } from "../tui/theme";
import { parseDuration, short } from "./answers";
import {
  AddTimeDialog,
  BarWordmark,
  Button,
  ChatBar,
  DatePicker,
  HoursBar,
  longDate,
  mix,
  Pill,
  Toast,
  useDraft,
  useToast,
} from "./kit";
import { type Card, useSheet } from "./model";
import { type Project, Setup } from "./Setup";

/** Pretend history so the date picker shows a lived-in month. */
function pretendDraft(date: string): boolean {
  const d = new Date(`${date}T12:00:00Z`);
  const dow = d.getUTCDay();
  return dow !== 0 && dow !== 6 && (d.getUTCDate() * 7) % 6 !== 0;
}

/** Claude Code projects seen on the fixture day, plus a couple from earlier in the month. */
function projectsOf(day: Day): Project[] {
  const sessions = new Map<string, Set<string>>();
  for (const b of day.blocks)
    for (const a of b.evidence)
      if (a.source === "claude-code" && a.sessionId) {
        const name = a.repo ?? b.project;
        sessions.set(name, (sessions.get(name) ?? new Set()).add(a.sessionId));
      }
  return [
    ...[...sessions].map(([name, s]) => ({ name, today: s.size, month: s.size * 6 })),
    { name: "dev-example/notes", today: 0, month: 3 },
    { name: "acme/web", today: 0, month: 7 },
  ];
}

/**
 * The prototype app: a home screen (the logo standing on today's hours, and the chat bar) and
 * a day view (one roomy card per timesheet row, each with a big duration you can click and
 * type over). Setup opens over either with ctrl+p or the chat bar's button.
 */
export function Clockout({
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
  const [date, setDate] = useState(day.date);
  const [view, setView] = useState<"home" | "day">("home");
  const [setup, setSetup] = useState(false);
  const [target, setTarget] = useState(8 * 60);

  useInput(
    (ch, key) => {
      if (key.ctrl && ch === "p") setSetup(true);
    },
    { isActive: !setup },
  );

  const shown: Day =
    date === day.date
      ? day
      : {
          date,
          timezone: day.timezone,
          blocks: [],
          gaps: computeGaps(date, [], config),
          questions: [],
          notes: [],
        };
  const screen = { width, height };
  return (
    <Box width={width} height={height} backgroundColor={T.bg}>
      <Flow
        key={date}
        day={shown}
        today={day.date}
        config={config}
        width={width}
        height={height}
        view={view}
        target={target}
        blocked={setup}
        onView={setView}
        onDate={setDate}
        onSetup={() => setSetup(true)}
      />
      {setup ? (
        <Setup
          screen={screen}
          projects={projectsOf(day)}
          target={target}
          onTarget={setTarget}
          onClose={() => setSetup(false)}
        />
      ) : null}
    </Box>
  );
}

function Flow({
  day,
  today,
  config,
  width,
  height,
  view,
  target,
  blocked,
  onView,
  onDate,
  onSetup,
}: {
  day: Day;
  today: string;
  config: Config;
  width: number;
  height: number;
  view: "home" | "day";
  target: number;
  blocked: boolean;
  onView: (v: "home" | "day") => void;
  onDate: (d: string) => void;
  onSetup: () => void;
}) {
  const sheet = useSheet(day, config);
  const step = durationMinutes(config.day.round_to);
  const [overlay, setOverlay] = useState<"date" | "add" | null>(null);
  const [sel, setSel] = useState(-1);
  const [chip, setChip] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [toast, showToast] = useToast();
  const draft = useDraft(!blocked && overlay === null && editing === null);
  const pill = useDraft(!blocked && editing !== null);
  const offset = useRef(0);

  // The day view's list: cards, then the "add time" card.
  const items: (Card | "add")[] = [...sheet.cards, "add"];
  const current = sel >= 0 ? items[Math.min(sel, items.length - 1)] : undefined;
  const card = current && current !== "add" ? current : undefined;

  const copy = () => {
    if (sheet.asks)
      return showToast(`Answer the ${sheet.asks} meeting${sheet.asks === 1 ? "" : "s"} first`);
    showToast(`✓ Copied ${sheet.sheet.length} rows · ${hm(sheet.minutes)}  (prototype)`);
  };
  const setMinutes = (c: Card, m: number) => {
    sheet.setMinutes(c.key, m);
    showToast(`✓ ${c.title} → ${hm(m)} · day ${hm(sheet.minutes - c.minutes + m)}`);
  };
  const startEdit = (i: number) => {
    const c = items[i];
    if (!c || c === "add" || c.kind !== "row") return;
    setSel(i);
    setEditing(c.key);
    pill.setValue("");
  };
  const commitEdit = () => {
    const c = sheet.cards.find((x) => x.key === editing);
    const m = parseDuration(pill.value);
    setEditing(null);
    if (c && m !== null) setMinutes(c, m);
  };
  const open = () => {
    onView("day");
    const words = draft.value.trim();
    draft.setValue("");
    if (words) showToast("Prototype: the AI would turn that into edits for you to approve");
  };

  useInput(
    (ch, key) => {
      if (overlay) return; // the overlay owns the keys
      if (editing) {
        if (key.escape) return setEditing(null);
        if (key.return) return commitEdit();
        pill.edit(ch, key);
        return;
      }
      if (key.ctrl && ch === "y") return copy();
      if (key.ctrl && ch === "z") return showToast(sheet.undo() ? "↶ Undone" : "Nothing to undo");
      if (view === "home") {
        if (key.escape) return draft.setValue("");
        if (key.return) return open();
        draft.edit(ch, key);
        return;
      }
      if (key.upArrow || key.downArrow) {
        const d = key.upArrow ? -1 : 1;
        setSel((s) => Math.max(0, Math.min(items.length - 1, s + d)));
        setChip(0);
        return;
      }
      if (draft.value === "" && card?.kind === "row") {
        if (ch === "+" || ch === "=") return setMinutes(card, card.minutes + step);
        if (ch === "-" || ch === "_") return setMinutes(card, Math.max(step, card.minutes - step));
      }
      if (draft.value === "" && card?.kind === "ask") {
        if (key.leftArrow) return setChip((c) => Math.max(0, c - 1));
        if (key.rightArrow) return setChip((c) => Math.min((card.choices?.length ?? 1) - 1, c + 1));
      }
      if (key.escape) {
        if (draft.value) return draft.setValue("");
        if (sel >= 0) return setSel(-1);
        return onView("home");
      }
      if (key.return) {
        const typed = parseDuration(draft.value);
        if (typed !== null && card?.kind === "row") {
          draft.setValue("");
          return setMinutes(card, typed);
        }
        if (draft.value.trim()) {
          draft.setValue("");
          return showToast("Prototype: the AI would turn that into edits for you to approve");
        }
        if (current === "add") return setOverlay("add");
        if (card?.kind === "row") return startEdit(sel);
        if (card?.kind === "ask") {
          const c = card.choices?.[chip];
          if (c) showToast(sheet.choose(c) ?? `✓ ${c.label}`);
          return;
        }
        return copy();
      }
      draft.edit(ch, key);
    },
    { isActive: !blocked },
  );

  const box = Math.min(84, Math.max(48, width - 10));
  // Home sits a little above centre so the date picker can drop below the chat bar.
  const HOME = 14;
  const PICKER = 13;
  const homeTop = Math.max(1, Math.floor((height - HOME - PICKER) / 2));
  const dropDown = view === "home" && height - homeTop - HOME >= PICKER;
  const bar = (
    <ChatBar
      width={view === "home" ? box : Math.min(width - 4, 104)}
      value={draft.value}
      placeholder={
        view === "home"
          ? 'Tell me about your day…  "standup ran to 45 minutes"'
          : card?.kind === "row"
            ? `How long was “${card.title}”?  type 1h 45m, or say what changed`
            : 'Say what changed…  "standup ran to 45 minutes"'
      }
      date={day.date}
      today={today}
      onDate={() => setOverlay("date")}
      actions={
        <>
          {view === "day" ? <Button label="Copy sheet" tone="quiet" onClick={copy} /> : null}
          <Button label="Setup" tone="quiet" onClick={onSetup} />
        </>
      }
    />
  );
  const picker =
    overlay === "date" ? (
      <DatePicker
        date={day.date}
        today={today}
        hasDraft={(d) => d === today || pretendDraft(d)}
        left={1}
        top={dropDown ? 5 : undefined}
        bottom={dropDown ? undefined : 5}
        onPick={(d) => {
          setOverlay(null);
          onDate(d);
        }}
        onClose={() => setOverlay(null)}
      />
    ) : null;
  const screen = { width, height };
  const addDialog =
    overlay === "add" ? (
      <AddTimeDialog
        projects={sheet.projects.length ? sheet.projects : ["General"]}
        step={step}
        screen={screen}
        onClose={() => setOverlay(null)}
        onAdd={(p, m, s) => {
          setOverlay(null);
          showToast(sheet.addTime(p, m, s) ?? `✓ Added ${hm(m)} to ${short(p)}`);
        }}
      />
    ) : null;

  if (view === "home")
    return (
      <Box
        width={width}
        height={height}
        flexDirection="column"
        alignItems="center"
        paddingTop={homeTop}
      >
        <BarWordmark segments={sheet.segments} target={target} />
        <Box height={1} flexShrink={0} />
        <Text>
          {sheet.minutes ? (
            <>
              <Text color={T.text} bold>
                {hm(sheet.minutes)}
              </Text>
              <Text color={T.muted}> of {hm(target)}</Text>
            </>
          ) : (
            <Text color={T.muted}>Nothing logged yet</Text>
          )}
        </Text>
        <Box height={1} />
        <Box flexDirection="column">
          {bar}
          {picker}
        </Box>
        {toast ? <Toast text={toast} bottom={2} /> : null}
      </Box>
    );

  // Day view: cards with room to breathe, the chat bar at the bottom.
  const listW = Math.min(width - 4, 104);
  // Rows left for cards: minus padding, header, bar, gap, chat bar (5), its margin and the
  // "↑ more" / "↓ more" lines. Each card is 5 rows plus a blank line.
  const avail = height - 1 - 1 - 1 - 1 - 5 - 1 - 2;
  const cap = Math.max(1, Math.floor((avail + 1) / 6));
  const focus = Math.max(0, sel);
  if (focus < offset.current) offset.current = focus;
  if (focus >= offset.current + cap) offset.current = focus - cap + 1;
  offset.current = Math.max(0, Math.min(offset.current, Math.max(0, items.length - cap)));
  const visible = items.slice(offset.current, offset.current + cap);

  return (
    <Box width={width} height={height} flexDirection="column" alignItems="center" paddingTop={1}>
      <Box width={listW} justifyContent="space-between" flexShrink={0}>
        <Clickable onClick={() => onView("home")}>
          {(hover) => (
            <Text>
              <Text color={hover ? T.text : T.muted}>← </Text>
              <Text color={T.text} bold>
                {longDate(day.date)}
              </Text>
            </Text>
          )}
        </Clickable>
        <Text>
          <Text color={T.text} bold>
            {hm(sheet.minutes)}
          </Text>
          <Text color={T.muted}> of {hm(target)}</Text>
          {sheet.minutes >= target ? <Text color={T.primary}> ✓</Text> : null}
        </Text>
      </Box>
      <Box flexShrink={0}>
        <HoursBar segments={sheet.segments} target={target} width={listW} />
      </Box>
      <Clickable
        flexDirection="column"
        flexGrow={1}
        width={listW}
        overflow="hidden"
        marginTop={1}
        onWheel={(d) => setSel((s) => Math.max(0, Math.min(items.length - 1, Math.max(0, s) + d)))}
      >
        {offset.current > 0 ? <Text color={T.faint}> ↑ {offset.current} more</Text> : null}
        {visible.map((it, k) => {
          const i = offset.current + k;
          if (it === "add")
            return (
              <AddCard
                key="add"
                width={listW}
                untracked={sheet.untracked}
                selected={i === sel}
                onClick={() => setOverlay("add")}
              />
            );
          return (
            <CardView
              key={it.key}
              c={it}
              width={listW}
              step={step}
              selected={i === sel}
              chip={i === sel ? chip : -1}
              editing={editing === it.key}
              typed={pill.value}
              onSelect={() => setSel(i)}
              onEdit={() => startEdit(i)}
              onMinutes={(m) => setMinutes(it, m)}
              onChoose={(n) => {
                const c = it.choices?.[n];
                if (c) showToast(sheet.choose(c) ?? `✓ ${c.label}`);
              }}
            />
          );
        })}
        {offset.current + cap < items.length ? (
          <Text color={T.faint}> ↓ {items.length - offset.current - cap} more</Text>
        ) : null}
      </Clickable>
      <Box flexDirection="column" marginBottom={1}>
        {bar}
        {picker}
      </Box>
      {addDialog}
      {toast ? <Toast text={toast} bottom={7} /> : null}
    </Box>
  );
}

function CardView({
  c,
  width,
  step,
  selected,
  chip,
  editing,
  typed,
  onSelect,
  onEdit,
  onMinutes,
  onChoose,
}: {
  c: Card;
  width: number;
  step: number;
  selected: boolean;
  chip: number;
  editing: boolean;
  typed: string;
  onSelect: () => void;
  onEdit: () => void;
  onMinutes: (m: number) => void;
  onChoose: (n: number) => void;
}) {
  const ask = c.kind === "ask";
  const color = projectColor(c.project);
  let body: ReactNode;
  if (ask)
    body = (
      <>
        <Text color={T.text} bold wrap="truncate-end">
          <Text color={T.ask}>? </Text>
          {c.title}
        </Text>
        <Text color={T.ask} wrap="truncate-end">
          {c.question}
          {c.reason ? <Text color={T.muted}> {c.reason}</Text> : null}
        </Text>
        <Box gap={1}>
          {(c.choices ?? []).map((ch, n) => (
            <Button
              key={ch.label}
              label={ch.label}
              tone={n === chip ? "ask" : "neutral"}
              onClick={() => onChoose(n)}
            />
          ))}
        </Box>
      </>
    );
  else
    body = (
      <>
        <Text color={T.text} bold wrap="truncate-end">
          {c.title}
        </Text>
        <Text wrap="truncate-end">
          <Text color={color}>● </Text>
          <Text color={T.text}>{short(c.project)}</Text>
          <Text color={T.muted}> · {c.task}</Text>
          {c.edited ? <Text color={T.primary}> · set by you</Text> : null}
        </Text>
        <Text color={T.faint} wrap="truncate-end">
          {c.from}
        </Text>
      </>
    );
  return (
    <Clickable onClick={onSelect} marginBottom={1} flexShrink={0}>
      {(hover) => (
        <Box
          width={width}
          borderStyle="round"
          borderColor={
            selected
              ? ask
                ? T.ask
                : T.text
              : ask
                ? mix(T.bg, T.ask, 0.5)
                : hover
                  ? T.muted
                  : T.border
          }
          paddingX={2}
        >
          <Box flexDirection="column" flexGrow={1} flexShrink={1}>
            {body}
          </Box>
          <Pill
            minutes={c.minutes}
            step={step}
            editing={editing}
            text={typed}
            edited={c.edited}
            dim={ask}
            onEdit={ask ? undefined : onEdit}
            onChange={ask ? undefined : onMinutes}
          />
        </Box>
      )}
    </Clickable>
  );
}

const DASHED = {
  topLeft: "╭",
  top: "┄",
  topRight: "╮",
  left: "┆",
  bottomLeft: "╰",
  bottom: "┄",
  bottomRight: "╯",
  right: "┆",
};

function AddCard({
  width,
  untracked,
  selected,
  onClick,
}: {
  width: number;
  untracked: number;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <Clickable onClick={onClick} flexShrink={0}>
      {(hover) => (
        <Box
          width={width}
          borderStyle={DASHED}
          borderColor={selected || hover ? T.text : T.border}
          paddingX={2}
          justifyContent="space-between"
          alignItems="center"
          height={5}
        >
          <Box flexDirection="column">
            <Text color={T.text} bold>
              + Add time
            </Text>
            <Text color={T.muted}>
              {untracked
                ? `${hm(untracked)} untracked on this day`
                : "for anything nothing recorded"}
            </Text>
          </Box>
          <Text color={T.faint}>project · how long · what</Text>
        </Box>
      )}
    </Clickable>
  );
}
