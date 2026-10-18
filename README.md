# Clockout

A local-first terminal app that turns your day — coding-agent sessions, git/GitHub activity and calendar — into a short, ready-to-paste timesheet. You fill gaps and fix entries by voice, and the AI work runs on the coding-agent subscription you already have.

Built for the **#NoHandsChallenge** (WeMakeDevs × Wispr Flow).

> Status: scaffolded. Building the personal MVP — see the [plan](docs/plan.md).

## Development

```sh
corepack enable
pnpm install
pnpm exec lefthook install
pnpm check               # lint, typecheck, build, test, publint
node dist/cli.js --help
```

Coding agents and contributors: start with [AGENTS.md](AGENTS.md).

## Docs

- [Spec](docs/spec.md)
- [Plan](docs/plan.md)
- [Decisions](docs/adr/)
- [Research](docs/research.md)

## License

MIT
