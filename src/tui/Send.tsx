import { Box, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { changes, describeItem, type PushItem, type PushPlan, type PushRow } from "../core/push";
import type { RemoteTask } from "../targets/types";
import { Clickable } from "./clickable";
import { Button, Dialog, Spinner, Typed, useDraft } from "./kit";
import { hm, T } from "./theme";

const MARK: Record<PushItem["action"], { ch: string; color: string }> = {
  create: { ch: "+", color: T.primary },
  update: { ch: "~", color: T.ask },
  delete: { ch: "−", color: T.danger },
  same: { ch: "=", color: T.faint },
  unmapped: { ch: "?", color: T.ask },
  blocked: { ch: "!", color: T.danger },
  theirs: { ch: "·", color: T.faint },
};

/** Stable within a plan: each row and each ERP entry appears once. */
function itemId(i: PushItem): string {
  if ("row" in i && i.row) return i.row.key;
  return "remote" in i && i.remote ? i.remote.id : "";
}

/** What sending would do, above the chat bar like a proposed correction. */
export function SendPanel({
  width,
  plan,
  site,
  onSend,
  onCancel,
}: {
  width: number;
  plan: PushPlan;
  /** The ERP's host, for the title. */
  site: string;
  onSend: () => void;
  onCancel: () => void;
}) {
  const n = changes(plan).length;
  const hours = plan.items.reduce(
    (s, i) =>
      s +
      (i.action === "create" || i.action === "update" || i.action === "same" ? i.want.hours : 0),
    0,
  );
  return (
    <Box
      width={width}
      flexDirection="column"
      flexShrink={0}
      backgroundColor={T.panel}
      borderStyle="bold"
      borderTop={false}
      borderRight={false}
      borderBottom={false}
      borderLeftColor={T.primary}
      paddingX={2}
      paddingY={1}
      marginBottom={1}
    >
      <Text color={T.primary} bold>
        {n ? `Send to ${site}` : `${site} is up to date`}
        <Text color={T.muted}> · {hm(Math.round(hours * 60))} from Clockout</Text>
      </Text>
      {plan.items.map((i) => (
        <Text
          key={`${i.action}:${itemId(i)}`}
          color={i.action === "same" || i.action === "theirs" ? T.muted : T.text}
          wrap="truncate-end"
        >
          <Text color={MARK[i.action].color}>{MARK[i.action].ch} </Text>
          {describeItem(i)}
        </Text>
      ))}
      <Box gap={1} marginTop={1}>
        {n ? (
          <Button
            label={`Send ${n} change${n === 1 ? "" : "s"} ↵`}
            tone="primary"
            onClick={onSend}
          />
        ) : null}
        <Button label={n ? "Not now · esc" : "Close · esc"} onClick={onCancel} />
      </Box>
    </Box>
  );
}

/**
 * Which ERP task a project's rows go to: type to search the ERP's tasks, ↑↓ and enter (or
 * click) to pick. Asked once per project; the answer is saved in config.
 */
export function TaskPicker({
  row,
  query: initial = "",
  search,
  screen,
  onPick,
  onClose,
}: {
  row: Pick<PushRow, "project" | "task" | "description">;
  /** What to search for first. */
  query?: string;
  search: (query: string) => Promise<RemoteTask[]>;
  screen: { width: number; height: number };
  onPick: (task: RemoteTask) => void;
  onClose: () => void;
}) {
  const name = row.project.split("/").pop() ?? row.project;
  const draft = useDraft(true, initial);
  const [tasks, setTasks] = useState<RemoteTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sel, setSel] = useState(0);
  const query = draft.value.trim();

  useEffect(() => {
    let live = true;
    const t = setTimeout(
      () => {
        search(query)
          .then((found) => {
            if (!live) return;
            setTasks(found);
            setError(null);
            setSel(0);
          })
          .catch((err: Error) => live && setError(err.message));
      },
      query ? 250 : 0,
    );
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [query, search]);

  const rows = Math.max(3, Math.min(10, screen.height - 16));
  const shown = (tasks ?? []).slice(0, rows);
  useInput((ch, key) => {
    if (key.escape) return onClose();
    if (key.upArrow) return setSel((s) => Math.max(0, s - 1));
    if (key.downArrow) return setSel((s) => Math.min(shown.length - 1, s + 1));
    if (key.return) {
      const t = shown[sel];
      if (t) onPick(t);
      return;
    }
    draft.edit(ch, key);
  });

  const width = Math.min(84, screen.width - 4);
  return (
    <Dialog title="Which ERP task is this?" width={width} screen={screen} onClose={onClose}>
      <Text color={T.text} wrap="truncate-end">
        {row.project} <Text color={T.muted}>· {row.task}</Text>
      </Text>
      <Text color={T.muted} wrap="truncate-end">
        {row.description}
      </Text>
      <Box height={1} />
      <Box backgroundColor={T.element} paddingX={1} width={width - 6}>
        <Text wrap="truncate-start">
          <Typed value={draft.value} placeholder={`search tasks, e.g. ${name}`} />
        </Text>
      </Box>
      <Box height={1} />
      {error ? (
        <Text color={T.danger}>{error}</Text>
      ) : tasks === null ? (
        <Text color={T.muted}>
          <Spinner /> Looking up your tasks…
        </Text>
      ) : shown.length === 0 ? (
        <Text color={T.muted}>No tasks match. Try another word.</Text>
      ) : (
        shown.map((t, i) => (
          <Clickable key={t.id} onClick={() => onPick(t)}>
            {(hover) => (
              <Text
                wrap="truncate-end"
                backgroundColor={i === sel ? T.elementHi : hover ? T.element : undefined}
              >
                <Text color={T.text}>{t.subject}</Text>
                <Text color={T.muted}> · {t.project}</Text>
              </Text>
            )}
          </Clickable>
        ))
      )}
      <Box height={1} />
      <Text color={T.faint}>
        ↑↓ choose · enter pick · every {row.project} row goes there from now on
      </Text>
    </Dialog>
  );
}
