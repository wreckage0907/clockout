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

Outside contributions come as pull requests. `main` is protected, and CI must pass (lint, typecheck, build, tests on Node 22 and 24, macOS and Ubuntu) before one can merge.

- Fork the repository (or branch, if you have write access) and branch from `main`, e.g. `fix/gap-questions`, then open a PR with `gh pr create --fill`.
- One focused change per PR, with Conventional Commit titles. PRs are squash-merged.
- `pnpm check` passes.
- Never include real session logs, calendar data or tokens in fixtures, issues or PRs.

## Reporting a bug or a vulnerability

Bugs and ideas go in [issues](https://github.com/wreckage0907/clockout/issues/new/choose). Security problems don't: see [SECURITY.md](SECURITY.md).
