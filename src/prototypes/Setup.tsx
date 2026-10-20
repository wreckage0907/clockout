import { Box, Text, useInput } from "ink";
import { type ReactNode, useState } from "react";
import { Clickable } from "../tui/clickable";
import { hm, T } from "../tui/theme";
import { Button, Dialog, Spinner, useDraft } from "./kit";

interface Source {
  id: string;
  group: string;
  title: string;
  /** Shown when it's on. */
  found: string;
  state: "on" | "off" | "missing" | "soon";
  /** Ticking it means signing in. */
  signIn?: boolean;
  /** Has sessions you can search and pick from. */
  sessions?: boolean;
}

const SOURCES: Source[] = [
  {
    id: "gcal",
    group: "calendar",
    title: "Google Calendar",
    found: "6 events on Friday",
    state: "off",
    signIn: true,
  },
  {
    id: "claude",
    group: "coding sessions",
    title: "Claude Code",
    found: "4 sessions on Friday",
    state: "on",
    sessions: true,
  },
  { id: "codex", group: "coding sessions", title: "Codex", found: "", state: "missing" },
  { id: "opencode", group: "coding sessions", title: "opencode", found: "", state: "soon" },
  { id: "github", group: "code", title: "GitHub", found: "2 PRs and a review", state: "on" },
];

export interface Project {
  name: string;
  today: number;
  month: number;
}

const ROUNDING = [5, 15, 30];

/**
 * Setup, over whatever screen you're on (ctrl+p or the chat bar's Setup button). Every source
 * is a block you tick; coding agents open into a searchable list of the projects they found,
 * each tickable. Then your daily target and the AI helper; the rest waits under "More".
 */
export function Setup({
  screen,
  projects,
  target,
  onTarget,
  onClose,
}: {
  screen: { width: number; height: number };
  projects: Project[];
  target: number;
  onTarget: (minutes: number) => void;
  onClose: () => void;
}) {
  const [on, setOn] = useState(() => SOURCES.filter((s) => s.state === "on").map((s) => s.id));
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [picked, setPicked] = useState(() => projects.map((p) => p.name));
  const [ai, setAi] = useState<"claude" | "none">("claude");
  const [more, setMore] = useState(false);
  const [start, setStart] = useState(9 * 60 + 30);
  const [end, setEnd] = useState(18 * 60 + 30);
  const [round, setRound] = useState(15);
  const search = useDraft(open !== null);

  const tick = (s: Source) => {
    if (s.state === "missing" || s.state === "soon" || busy) return;
    if (on.includes(s.id)) return setOn((ids) => ids.filter((id) => id !== s.id));
    if (!s.signIn) return setOn((ids) => [...ids, s.id]);
    setBusy(s.id);
    setTimeout(() => {
      setBusy(null);
      setOn((ids) => [...ids, s.id]);
    }, 1200);
  };
  const press = (s: Source) => (s.sessions ? setOpen((o) => (o === s.id ? null : s.id)) : tick(s));

  useInput((ch, key) => {
    if (key.escape) {
      if (search.value) return search.setValue("");
      if (open) return setOpen(null);
      return onClose();
    }
    if (key.ctrl && ch === "p") return onClose();
    if (open) search.edit(ch, key);
  });

  const width = Math.min(96, screen.width - 4);
  const inner = width - 6;
  const shown = projects.filter((p) => p.name.toLowerCase().includes(search.value.toLowerCase()));
  const clock = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

  return (
    <Dialog title="Setup" width={width} screen={screen} onClose={onClose}>
      <Text color={T.muted}>Tick what Clockout reads. Nothing leaves this machine.</Text>
      <Box height={1} />
      <Box flexWrap="wrap" columnGap={1} rowGap={0} width={inner}>
        {SOURCES.map((s) => (
          <SourceBlock
            key={s.id}
            s={s}
            on={on.includes(s.id)}
            busy={busy === s.id}
            expanded={open === s.id}
            detail={
              s.sessions && on.includes(s.id)
                ? `${picked.length} of ${projects.length} projects`
                : undefined
            }
            onTick={() => tick(s)}
            onPress={() => press(s)}
          />
        ))}
      </Box>

      {open ? (
        <Box flexDirection="column" marginTop={1} width={inner}>
          <Box backgroundColor={T.element} paddingX={1}>
            <Text color={T.faint}>⌕ </Text>
            {search.value ? (
              <Text color={T.text}>
                {search.value}
                <Text inverse> </Text>
              </Text>
            ) : (
              <Text color={T.muted}>
                <Text inverse>S</Text>earch Claude Code projects
              </Text>
            )}
          </Box>
          {shown.map((p) => {
            const isOn = picked.includes(p.name);
            return (
              <Clickable
                key={p.name}
                onClick={() =>
                  setPicked((ps) => (isOn ? ps.filter((x) => x !== p.name) : [...ps, p.name]))
                }
              >
                {(hover) => (
                  <Box backgroundColor={hover ? T.element : undefined} paddingX={1} width={inner}>
                    <Box width={3}>
                      <Text color={isOn ? T.primary : T.faint}>{isOn ? "✓" : "○"}</Text>
                    </Box>
                    <Box flexGrow={1}>
                      <Text color={isOn ? T.text : T.muted}>{p.name}</Text>
                    </Box>
                    <Text color={T.faint}>
                      {p.today ? `${p.today} today · ` : ""}
                      {p.month} this month
                    </Text>
                  </Box>
                )}
              </Clickable>
            );
          })}
          {shown.length === 0 ? (
            <Text color={T.muted}> No project matches “{search.value}”.</Text>
          ) : null}
        </Box>
      ) : null}

      <Box height={1} />
      <Row label="Daily target">
        <Button label="−" onClick={() => onTarget(Math.max(60, target - 30))} />
        <Box width={7} justifyContent="center">
          <Text color={T.text} bold>
            {hm(target)}
          </Text>
        </Box>
        <Button label="+" onClick={() => onTarget(Math.min(16 * 60, target + 30))} />
        <Text color={T.faint}> the bar behind the logo fills towards this</Text>
      </Row>
      <Row label="AI helper">
        <Button
          label="Claude Code"
          tone={ai === "claude" ? "primary" : "neutral"}
          onClick={() => setAi("claude")}
        />
        <Button
          label="No AI"
          tone={ai === "none" ? "primary" : "neutral"}
          onClick={() => setAi("none")}
        />
        <Text color={T.faint}> writes summaries and reads what you type</Text>
      </Row>

      <Box marginTop={1}>
        <Clickable onClick={() => setMore((m) => !m)}>
          {(hover) => <Text color={hover ? T.text : T.muted}>{more ? "▾ More" : "▸ More"}</Text>}
        </Clickable>
      </Box>
      {more ? (
        <>
          <Row label="Working hours">
            <Button label="−" onClick={() => setStart((m) => Math.max(0, m - 30))} />
            <Text color={T.text}>{clock(start)}</Text>
            <Button label="+" onClick={() => setStart((m) => Math.min(end - 60, m + 30))} />
            <Text color={T.muted}> to </Text>
            <Button label="−" onClick={() => setEnd((m) => Math.max(start + 60, m - 30))} />
            <Text color={T.text}>{clock(end)}</Text>
            <Button label="+" onClick={() => setEnd((m) => Math.min(24 * 60, m + 30))} />
          </Row>
          <Row label="Round to">
            {ROUNDING.map((r) => (
              <Button
                key={r}
                label={`${r}m`}
                tone={round === r ? "primary" : "neutral"}
                onClick={() => setRound(r)}
              />
            ))}
          </Row>
        </>
      ) : null}
    </Dialog>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Box gap={1} alignItems="center">
      <Box width={15}>
        <Text color={T.muted}>{label}</Text>
      </Box>
      {children}
    </Box>
  );
}

function SourceBlock({
  s,
  on,
  busy,
  expanded,
  detail,
  onTick,
  onPress,
}: {
  s: Source;
  on: boolean;
  busy: boolean;
  expanded: boolean;
  detail?: string;
  onTick: () => void;
  onPress: () => void;
}) {
  const dead = s.state === "missing" || s.state === "soon";
  const line = busy
    ? "signing in…"
    : (detail ??
      (on
        ? s.found
        : s.state === "missing"
          ? "not installed"
          : s.state === "soon"
            ? "coming soon"
            : "tick to connect"));
  return (
    <Clickable onClick={onPress} width={22} flexShrink={0}>
      {(hover) => (
        <Box
          width={22}
          flexDirection="column"
          borderStyle="round"
          borderColor={expanded ? T.text : on ? T.primary : hover && !dead ? T.muted : T.border}
          backgroundColor={T.panel}
          borderBackgroundColor={T.panel}
          paddingX={1}
        >
          <Text color={T.faint}>
            {s.group}
            {s.sessions ? (expanded ? "  ▴" : "  ▾") : ""}
          </Text>
          <Box>
            <Clickable onClick={onTick}>
              {(h) =>
                busy ? (
                  <Spinner />
                ) : (
                  <Text color={on ? T.primary : dead ? T.faint : h ? T.text : T.muted}>
                    {on ? "✓" : "○"}
                  </Text>
                )
              }
            </Clickable>
            <Text color={dead ? T.faint : T.text} bold={on} wrap="truncate-end">
              {" "}
              {s.title}
            </Text>
          </Box>
          <Text color={on ? T.muted : T.faint} wrap="truncate-end">
            {line}
          </Text>
        </Box>
      )}
    </Clickable>
  );
}
