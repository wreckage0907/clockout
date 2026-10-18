import clipboard from "clipboardy";
import { render } from "ink";
import { parseCorrection } from "../ai/edits";
import type { LlmBackend } from "../ai/types";
import { openDay } from "../collect";
import type { Config } from "../config/schema";
import { commitEdits, undoEdit } from "../corrections";
import type { DayStore } from "../store/json-store";
import { App, type AppActions } from "./App";

export async function runTui(
  date: string,
  config: Config,
  store: DayStore,
  backend: LlmBackend | null,
) {
  const actions: AppActions = {
    load: (d) => openDay(d, config, store, { ai: backend }),
    parse: backend ? (text, day) => parseCorrection(text, day, config, backend) : null,
    commit: (stored, ops, text) => commitEdits(stored, ops, config, store, text),
    undo: (stored) => undoEdit(stored, store),
    copy: (text) => clipboard.write(text),
  };
  const app = render(
    <App initialDate={date} config={config} actions={actions} aiLabel={backend?.label ?? null} />,
    {
      exitOnCtrlC: true,
    },
  );
  await app.waitUntilExit();
}
