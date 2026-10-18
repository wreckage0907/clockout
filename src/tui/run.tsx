import clipboard from "clipboardy";
import { render } from "ink";
import { parseCorrection } from "../ai/edits";
import type { LlmBackend } from "../ai/types";
import { openDay } from "../collect";
import type { AppContext } from "../commands/context";
import { commitEdits, undoEdit } from "../corrections";
import { App, type AppActions } from "./App";

export async function runTui(date: string, app: AppContext, backend: LlmBackend | null) {
  const { config, store, demo } = app;
  const actions: AppActions = {
    load: (d) =>
      openDay(d, config, store, {
        ai: backend,
        ...(demo ? { sources: demo.sources, ctx: demo.ctx } : {}),
      }),
    parse: backend ? (text, day) => parseCorrection(text, day, config, backend) : null,
    commit: (stored, ops, text) => commitEdits(stored, ops, config, store, text),
    undo: (stored) => undoEdit(stored, store),
    copy: (text) => clipboard.write(text),
  };
  const ui = render(
    <App initialDate={date} config={config} actions={actions} aiLabel={backend?.label ?? null} />,
    {
      exitOnCtrlC: true,
    },
  );
  await ui.waitUntilExit();
}
