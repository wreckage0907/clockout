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
node dist/cli.js demo     # run the built CLI on the fixture day
pnpm test                # vitest; builds dist/ first
pnpm exec vitest run test/path/to/file.test.ts   # one test file
pnpm lint                # biome check
pnpm fix                 # biome check --write (format + safe fixes)
pnpm typecheck           # tsc (TypeScript 7)
pnpm check               # everything CI runs
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
src/cli.ts        entry; wires commander to commands/
src/commands/     one file per subcommand; thin
src/core/         domain logic. No IO, no Ink, no process access.
src/sources/      one folder per source; each only emits Activity records
src/ai/           LlmBackend interface + backends; prompts and output schemas
src/tui/          Ink components. Render state; never fetch.
src/export/       formatters for clipboard, Markdown, CSV
src/config/       zod schema, TOML load/save, XDG paths
src/store/        JSON store for days and corrections
src/collect.ts    runs sources for a day, builds and saves it (openDay)
src/corrections.ts applies edits to a stored day with undo
src/targets/      timesheet systems the day is sent to (next-pms); read and write entries only
src/push.ts       plans and applies sending a day to a target, keeps the record of what was sent
src/oauth.ts      loopback + PKCE for browser sign-ins
src/demo.ts       --demo: bundled fixtures, temp store, fixed date
```

- `core/` must never import from `tui/`, `sources/`, `ai/` or Node built-ins with side effects. It may import `config/schema` (pure).
- Sources never decide projects, durations or summaries; `core/` does.
- The AI never rewrites the timesheet. It returns edit operations that `core/edits` validates and applies.

## Privacy and safety

- All data stays on the user's machine. No telemetry.
- Never read or log credential files (`~/.codex/auth.json`, keychains, `.env`, tokens). Get the GitHub token only via `gh auth token` or `GITHUB_TOKEN`, and never print it.
- AI backends get titles, branch names and commit subjects only, never code or full prompts.
- Run `claude -p` with tools off, no session persistence, in an empty temp dir.
- Test fixtures are synthetic. Never copy real session logs, calendar data or PRs into `test/fixtures/`.

## Testing

- vitest. Tests live in `test/`, mirroring `src/`.
- Sources: feed files from `test/fixtures/` (same layout as the real tool, e.g. `fixtures/claude/projects/<slug>/<id>.jsonl`). No live network or API calls.
- TUI: `ink-testing-library`.
- `test/e2e/` runs the built CLI.

## Commits and pull requests

Every change goes through a pull request; `main` is protected and only accepts merged PRs with green CI.

1. Branch from an up-to-date `main`: `git switch main && git pull && git switch -c <type>/<short-name>` (e.g. `fix/gap-questions`).
2. Commit with Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`). The pre-commit hook (lefthook) runs Biome, the typecheck and the tests.
3. Push and open a PR: `git push -u origin HEAD && gh pr create --fill`. Say what changed, why, and how it was tested.
4. Wait for CI (`gh pr checks --watch`). Fix failures on the same branch.
5. The owner reviews and merges (squash). Don't merge your own PR unless asked.

## Never

- Create `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md`: Claude Code stops reading this file when any of them exists.
- Weaken `tsconfig.json` or Biome rules to make an error go away.
- Delete or skip a failing test to get green.
- Edit `dist/` or `pnpm-lock.yaml` by hand.
- Push to `main` directly; open a PR instead.

## Voice-driven work

Requests in this repo are often dictated (Wispr Flow), so names can be misheard: "Plot Code" or "Cloud Code" means Claude Code, "MBB" means MVP. If a file, package or command name in a request doesn't exist, check what was likely meant and confirm before acting on a guess.
