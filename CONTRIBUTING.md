# Contributing

Thanks for helping. Humans and coding agents follow the same guide: **[AGENTS.md](AGENTS.md)** has the commands, conventions and rules.

## Setup

```sh
corepack enable          # gives you the pnpm version pinned in package.json
pnpm install
pnpm exec lefthook install
pnpm check
```

Requires Node ≥ 22.12 (`.nvmrc` pins 24).

## Adding a source

Follow the [add-source skill](.agents/skills/add-source/SKILL.md): research the format, add synthetic fixtures, implement, test, document.

## Pull requests

`main` only accepts pull requests, and CI must pass (lint, typecheck, build, tests on Node 22 and 24, macOS and Ubuntu) before one can merge.

- Branch from `main`, e.g. `fix/gap-questions`, and open a PR with `gh pr create --fill`.
- One focused change per PR, with Conventional Commit titles. PRs are squash-merged.
- `pnpm check` passes.
- Never include real session logs, calendar data or tokens in fixtures, issues or PRs.
