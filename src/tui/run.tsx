import { homedir } from "node:os";
import clipboard from "clipboardy";
import { execa } from "execa";
import { render, useWindowSize } from "ink";
import { chooseBackend } from "../ai";
import { detectClaudeCli } from "../ai/claude-cli";
import { type Correction, localCorrection, parseCorrection } from "../ai/edits";
import type { LlmBackend } from "../ai/types";
import { openDay } from "../collect";
import { signInErp, signOutErp, signOutGoogle } from "../commands/connect";
import type { AppContext } from "../commands/context";
import {
  loadErpCredentials,
  loadGoogleCredentials,
  saveGoogleCredentials,
} from "../config/credentials";
import { withErpSite, withSource, withTaskMapping } from "../config/edit";
import { loadConfig, saveConfig } from "../config/load";
import { resolvePaths } from "../config/paths";
import type { Config } from "../config/schema";
import { applySettings, type SettingEffect } from "../config/setting-ops";
import { localDate } from "../core/time";
import { commitEdits, undoEdit } from "../corrections";
import { applyPush, preparePush } from "../push";
import { listClaudeProjects } from "../sources/claude-code/paths";
import { detectGitHub } from "../sources/github/token";
import { connectGoogle, googleClient } from "../sources/google-calendar/oauth";
import { openTarget } from "../targets";
import type { Target } from "../targets/types";
import { App, type AppActions, type SendActions } from "./App";
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

  // The ERP connection, opened on first use and again if its address changes.
  let target: { url: string; t: Promise<Target | null> } | null = null;
  const erp = (): Promise<Target> => {
    const url = config.timesheet?.url ?? "";
    if (!target || target.url !== url) target = { url, t: openTarget(config) };
    const t = target.t;
    t.catch(() => {
      target = null;
    });
    return t.then((x) => {
      if (!x) throw new Error("No ERP is set up.");
      return x;
    });
  };
  const send: SendActions = {
    get site() {
      return config.timesheet ? new URL(config.timesheet.url).host : "";
    },
    plan: async (s) => preparePush(s, config, await erp()),
    apply: async (s, plan) => applyPush(s, plan, await erp(), store),
    searchTasks: async (q) => (await erp()).searchTasks(q),
    async map(mapping) {
      await saveConfig(configFile, withTaskMapping(config, mapping));
      config = (await loadConfig(configFile)) ?? config;
      return config;
    },
  };

  const claudeProjects = () => {
    const claude = config.sources.find((s) => s.type === "claude-code");
    return listClaudeProjects(ctx, new Date(Date.now() - 7 * 86_400_000), claude?.projects_dir);
  };
  /** An ERP task named in the chat: picked straight away when the search finds just one. */
  const findTasks = async (said: Correction): Promise<Correction> => {
    if (!config.timesheet || !said.settings?.some((s) => s.op === "erp_task")) return said;
    const settings = await Promise.all(
      said.settings.map(async (s) => {
        if (s.op !== "erp_task" || s.erp_task) return s;
        const found = await send.searchTasks(s.search).catch(() => []);
        const exact = found.filter((t) => t.subject.toLowerCase() === s.search.toLowerCase());
        const one = found.length === 1 ? found[0] : exact.length === 1 ? exact[0] : undefined;
        return one ? { ...s, erp_task: one.id, label: one.subject } : s;
      }),
    );
    return { ...said, settings };
  };

  const actions: AppActions = {
    load: (d) => openDay(d, config, store, { ai }),
    async parse(text, day, earlier) {
      if (!ai) {
        const local = localCorrection(text);
        if (local) return local;
        throw new Error("Typed corrections need the AI helper. Turn it on in Setup (ctrl+p).");
      }
      const [projects, google, erpCreds] = await Promise.all([
        claudeProjects(),
        loadGoogleCredentials().catch(() => null),
        loadErpCredentials().catch(() => null),
      ]);
      const facts = {
        googleConnected: google !== null,
        erpConnected: erpCreds !== null,
        claudeProjects: projects,
      };
      return findTasks(await parseCorrection(text, day, config, ai, { facts, earlier }));
    },
    async configure(ops) {
      const r = applySettings(config, ops, await claudeProjects());
      if (r.errors.length) throw new Error(r.errors.join(" "));
      let next = r.config;
      let pick: Extract<SettingEffect, { kind: "pick_task" }> | undefined;
      const google = { type: "google-calendar" as const, calendars: ["primary"] };
      for (const e of r.effects) {
        if (e.kind === "pick_task") pick = e;
        else if (e.kind === "connect" && e.service === "google") {
          if (!(await loadGoogleCredentials().catch(() => null)))
            await actions.setup.connectGoogle();
          next = withSource(next, google, true);
        } else if (e.kind === "connect") {
          const site = e.url ?? next.timesheet?.url;
          if (!site) throw new Error("Say where your ERP is: “connect my ERP at erp.example.com”.");
          next = withErpSite(next, (await signInErp(site, openQuietly)).url);
          target = null;
        } else if (e.service === "google") {
          await signOutGoogle();
          next = withSource(next, google, false);
        } else {
          await signOutErp();
          target = null;
        }
      }
      config = await actions.setup.save(next);
      return { config, ...(pick ? { pick } : {}) };
    },
    commit: (stored, ops, text) => commitEdits(stored, ops, config, store, text),
    undo: (stored) => undoEdit(stored, store),
    copy: (text) => clipboard.write(text),
    savedDates: () => store.dates(),
    get send() {
      return config.timesheet ? send : undefined;
    },
    setup: {
      async state() {
        const [projects, github, cli, google, erpCreds] = await Promise.all([
          claudeProjects(),
          detectGitHub(ctx),
          detectClaudeCli(),
          loadGoogleCredentials().catch(() => null),
          loadErpCredentials().catch(() => null),
        ]);
        const signedIn =
          !!erpCreds &&
          !!config.timesheet &&
          new URL(erpCreds.url).origin === new URL(config.timesheet.url).origin;
        return {
          config,
          googleConnected: google !== null,
          claude: { found: projects.length > 0, projects },
          github: { found: github !== null },
          aiFound: cli !== null,
          erp: {
            connected: signedIn,
            ...(signedIn && erpCreds?.user ? { user: erpCreds.user } : {}),
          },
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
      async connectErp(site) {
        const connected = await signInErp(site, openQuietly);
        target = null;
        const saved = await actions.setup.save(withErpSite(config, connected.url));
        return { config: saved, ...(connected.user ? { user: connected.user } : {}) };
      },
      async disconnectErp() {
        await signOutErp();
        target = null;
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
