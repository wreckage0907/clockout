# 0004. Toolchain

Status: accepted (2026-10-18)

## Decision

| Tool               | Choice                                            | Why                                                                                                                                                     |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package manager    | pnpm 11, pinned via `packageManager`              | pnpm 12 ships as a native binary that Corepack (≤ 0.36) can't launch, so `pnpm` breaks for anyone using Corepack. Move to 12 once Corepack supports it. |
| Repo shape         | Single package with strict layers                 | Split into workspaces only if an MCP server or web view becomes real.                                                                                   |
| Type-checking      | TypeScript 7 (native)                             | Fast. Fall back to 6 if a tool needs the TS JS API.                                                                                                     |
| Build              | tsdown, ESM, `dist/cli.js`                        | Bundles the CLI; dependencies stay external.                                                                                                            |
| Lint and format    | Biome                                             | One tool; ESLint's type-aware rules don't support TS 7 yet.                                                                                             |
| Tests              | vitest; global setup builds `dist/` for e2e tests | Same as most reference repos.                                                                                                                           |
| Git hooks          | lefthook (Biome, typecheck and tests on commit)   | Its install script is denied in `pnpm-workspace.yaml`; hooks are installed with `pnpm exec lefthook install`.                                           |
| Agent instructions | `AGENTS.md` only                                  | Claude Code ≥ 2.1.277 reads it when no `CLAUDE.md` exists; other agents read it natively.                                                               |
