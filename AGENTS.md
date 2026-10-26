# AGENTS.md

Clockout turns a developer's day (coding-agent sessions, GitHub activity, calendar) into a ready-to-paste timesheet that the user corrects by voice in a terminal UI.

- What to build: [docs/spec.md](docs/spec.md). Current scope is the personal MVP: Claude Code + GitHub + Google Calendar (ICS) → review in the TUI → export date, project, task, hours, description.
- What's next: [docs/plan.md](docs/plan.md). Pick the first unticked item unless told otherwise; tick it when done.
- Why things are the way they are: [docs/adr/](docs/adr/). Don't contradict an accepted ADR; propose a new one instead.

## Commands

```sh
pnpm install             # pnpm 11 via corepack (see ADR 0004)
pnpm dev                 # rebuild dist/ on change
pnpm build               # bundle src/cli.ts → dist/cli.js
node dist/cli.js day 2026-10-16 --plain --no-ai   # run the built CLI (needs a config)
pnpm test                # vitest; builds dist/ first
pnpm exec vitest run test/path/to/file.test.ts   # one test file
pnpm lint                # biome check
pnpm fix                 # biome check --write (format + safe fixes)
pnpm typecheck           # tsc (TypeScript 7)
pnpm check               # everything CI runs
pnpm smoke               # install the packed tarball and run the installed clockout
```

## Definition of done

1. `pnpm check` passes.
2. New behaviour has a test; new sources have fixture-based tests.
3. `docs/plan.md` is ticked; `docs/spec.md` updated if behaviour changed.
4. README updated if a command or flag changed.

## Conventions

- ESM only. Node ≥ 22.12. Imports have no file extensions (tsdown bundles; `moduleResolution: Bundler`).
- Strict TypeScript with `noUncheckedIndexedAccess`. No `any`; use `unknown` and narrow.
- Validate every external input with zod at the boundary: config, session lines, API responses, AI output.
- Times are `Date` in UTC internally; convert to the user's time zone only for display and export (`@date-fns/tz`).
- Small pure functions in `core/`; side effects at the edges.
- Exact dependency versions (pnpm saves them that way). Don't add a dependency without asking.

## Module boundaries

```
src/cli.ts        entry; checks the Node version, then loads main.ts
src/main.ts       wires commander to commands/
src/commands/     one file per subcommand; thin
src/core/         domain logic. No IO, no Ink, no process access.
src/sources/      one folder per source; each only emits Activity records (GitHub's open-work.ts also answers what's still open, for standups)
src/ai/           LlmBackend interface + backends; prompts and output schemas
src/tui/          Ink components. Render state; never fetch.
src/export/       formatters for clipboard, Markdown, CSV; send.ts writes where an export's `to` says
src/config/       zod schema, TOML load/save, XDG paths
src/store/        JSON store for days and corrections
src/collect.ts    runs sources for a day, builds and saves it (openDay)
src/corrections.ts applies edits to a stored day with undo
src/targets/      timesheet systems the day is sent to (next-pms, http); read and write entries only
src/push.ts       plans and applies sending a day to a target, keeps the record of what was sent
src/standup.ts    gathers a standup's facts (previous working day, today's calendar, open GitHub work) and writes it
src/mcp/          MCP client (streamable HTTP) and its sign-in; calls only tools named in config or code
src/oauth.ts      loopback + PKCE, discovery and registration for browser sign-ins
src/log.ts        local error log: full details behind the one-line messages, tokens redacted
src/command.ts    runs a program you named: one JSON request on stdin, one JSON answer (ADR 0009 layer 4)
src/schedule.ts   what a scheduled job does, when, for which day, and the unit text that runs it (ADR 0012)
src/run.ts        one scheduled run: the lock, the once-a-day guard, the run log, the exit code
src/lock.ts       one Clockout run at a time (and one credential writer)
src/files.ts      readable reasons a file couldn't be written
```

- `core/` must never import from `tui/`, `sources/`, `ai/` or Node built-ins with side effects. It may import `config/schema` (pure).
- Sources never decide projects, durations or summaries; `core/` does.
- The AI never rewrites the timesheet. It returns edit operations that `core/edits` validates and applies.

## Privacy and safety

- All data stays on the user's machine. No telemetry.
- Never read or log credential files (`~/.codex/auth.json`, keychains, `.env`, tokens). Get the GitHub token only via `gh auth token` or `GITHUB_TOKEN`, and never print it.
- AI backends get titles, branch names and commit subjects only, never code or full prompts. For setup by chat they also get a settings summary ([ADR 0007](docs/adr/0007-setup-from-the-chat-bar.md)): never credentials, private calendar links or folder paths.
- Run every agent CLI (claude, codex, opencode, pi) with tools off (or denied / read-only where there's no switch), nothing saved, in an empty temp dir; never with the user's own agent config or MCP servers where it can be avoided.
- Error messages say what's wrong and how to fix it; details go to the error log via `{ cause }`, never tokens.
- Test fixtures are synthetic. Never copy real session logs, calendar data or PRs into `test/fixtures/`.

## Testing

- vitest. Tests live in `test/`, mirroring `src/`.
- Sources: feed files from `test/fixtures/` (same layout as the real tool, e.g. `fixtures/claude/projects/<slug>/<id>.jsonl`). No live network or API calls.
- TUI: `ink-testing-library`.
- `test/e2e/` runs the built CLI as a separate process (`test/e2e/helpers.ts`): its own temp home, a PATH with only node (never your own agent CLIs, nor the `gh` CI runners have), sources from the fixtures, GitHub as a fake server, the mock PMS (`test/mock-pms/`, the timesheet API in docs/timesheet-api.md) and the mock MCP server (`test/mock-mcp/`, OAuth with registration; sign in by opening the printed address) on 127.0.0.1. Check exit code, stdout and stderr separately.
- `test/tty/` runs the review screen in a real pseudo-terminal through `test/tty/drive.py` (python3's standard library, run with `-I`): wait for text, keys, bracketed paste, resize, signals; then checks what reached the terminal on the way out (mouse off, main screen, cursor).
- `pnpm smoke` packs the package, installs the tarball like npm users get it and runs the installed `clockout` (CI runs it too).
- `pnpm coverage` counts every file in `src/`, loaded or not. Subprocess runs in `test/e2e/` don't count towards it.

## Commits

Commit straight to `main` and push; there are no pull requests (no one else reviews). CI still runs on every push.

1. Start from an up-to-date `main`: `git switch main && git pull`.
2. Commit with Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`). The pre-commit hook (lefthook) runs Biome, the typecheck and the tests.
3. `git push`, then check CI (`gh run watch`). Fix failures with a follow-up commit.

## Never

- Create `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`: Claude Code stops reading this file when any of them exists.
- Weaken `tsconfig.json` or Biome rules to make an error go away.
- Delete or skip a failing test to get green.
- Edit `dist/` or `pnpm-lock.yaml` by hand.
- Force-push to `main` or rewrite its history.

## Voice-driven work

Requests in this repo are often dictated (Wispr Flow), so names can be misheard: "Plot Code" or "Cloud Code" means Claude Code, "MBB" means MVP. If a file, package or command name in a request doesn't exist, check what was likely meant and confirm before acting on a guess.
