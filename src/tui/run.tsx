import { homedir } from "node:os";
import clipboard from "clipboardy";
import { execa } from "execa";
import { render, useWindowSize } from "ink";
import { chooseBackend } from "../ai";
import { detectClaudeCli } from "../ai/claude-cli";
import { parseCorrection } from "../ai/edits";
import type { LlmBackend } from "../ai/types";
import { openDay } from "../collect";
import type { AppContext } from "../commands/context";
import { loadGoogleCredentials, saveGoogleCredentials } from "../config/credentials";
import { loadConfig, saveConfig } from "../config/load";
import { resolvePaths } from "../config/paths";
import type { Config } from "../config/schema";
import { localDate } from "../core/time";
import { commitEdits, undoEdit } from "../corrections";
import { listClaudeProjects } from "../sources/claude-code/paths";
import { detectGitHub } from "../sources/github/token";
import { connectGoogle, googleClient } from "../sources/google-calendar/oauth";
import { App, type AppActions } from "./App";
import { MouseProvider } from "./clickable";
import { MOUSE_OFF, MOUSE_ON, withMouse } from "./mouse";

/** Opens a URL in the default browser, quietly: the screen belongs to the app. */
async function openQuietly(url: string): Promise<void> {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  await execa(cmd, args as string[]).catch(() => undefined);
}

/** The app at the terminal's current size. */
function Screen(props: Omit<Parameters<typeof App>[0], "width" | "height">) {
  const { columns, rows } = useWindowSize();
  return <App {...props} width={columns} height={rows} />;
}

/**
 * Runs the review app full screen, clickable. Config and the AI backend are kept here so a
 * change in setup applies to the next load and correction without restarting.
 */
export async function runTui(date: string, app: AppContext, backend: LlmBackend | null) {
  const { store } = app;
  let config: Config = app.config;
  let ai = backend;
  const { configFile } = resolvePaths();
  const ctx = { homeDir: homedir(), env: process.env };

  const actions: AppActions = {
    load: (d) => openDay(d, config, store, { ai }),
    hasAI: () => ai !== null,
    parse: (text, day) => {
      if (!ai) throw new Error("No AI helper is set up.");
      return parseCorrection(text, day, config, ai);
    },
    commit: (stored, ops, text) => commitEdits(stored, ops, config, store, text),
    undo: (stored) => undoEdit(stored, store),
    copy: (text) => clipboard.write(text),
    savedDates: () => store.dates(),
    setup: {
      async state() {
        const claude = config.sources.find((s) => s.type === "claude-code");
        const weekAgo = new Date(Date.now() - 7 * 86_400_000);
        const [projects, github, cli, google] = await Promise.all([
          listClaudeProjects(ctx, weekAgo, claude?.projects_dir),
          detectGitHub(ctx),
          detectClaudeCli(),
          loadGoogleCredentials().catch(() => null),
        ]);
        return {
          config,
          googleConnected: google !== null,
          claude: { found: projects.length > 0, projects },
          github: { found: github !== null },
          aiFound: cli !== null,
        };
      },
      async save(next) {
        await saveConfig(configFile, next);
        const loaded = (await loadConfig(configFile)) ?? next;
        const aiChanged = loaded.ai.backend !== config.ai.backend;
        config = loaded;
        if (aiChanged) ai = await chooseBackend(config).catch(() => null);
        return config;
      },
      async connectGoogle() {
        const client = googleClient(config);
        const { refreshToken, scope } = await connectGoogle(client, openQuietly);
        await saveGoogleCredentials({
          refresh_token: refreshToken,
          client_id: client.client_id,
          scope,
          connected_at: new Date().toISOString(),
        });
      },
    },
  };

  const { stdin, mouse, stop } = withMouse(process.stdin);
  const off = () => process.stdout.write(MOUSE_OFF);
  process.stdout.write(MOUSE_ON);
  process.once("exit", off);
  const today = localDate(new Date(), config.me.timezone);
  const ui = render(
    <MouseProvider events={mouse}>
      <Screen initialDate={date} today={today} config={config} actions={actions} />
    </MouseProvider>,
    { stdin, exitOnCtrlC: true, alternateScreen: true },
  );
  try {
    await ui.waitUntilExit();
  } finally {
    off();
    stop();
  }
}
