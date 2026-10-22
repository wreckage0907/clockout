# 0008. Read agents' SQLite with node:sqlite

Status: accepted (2026-10-22)

## Context

opencode 2 keeps its sessions only in SQLite (`opencode.db`), and the Antigravity CLI keeps its conversation titles and workspace folders in SQLite (`conversation_summaries.db`). Copilot CLI, Goose and Crush do the same. ADR 0003 kept Clockout's own store in JSON partly because `better-sqlite3` is a native addon and `node:sqlite` was experimental on Node 22.

Reading another tool's database is different from owning a store: it's read-only, the schema isn't ours, and a source that can't read is allowed to find nothing.

## Decision

- Sources read other tools' SQLite with Node's built-in `node:sqlite`, opened read-only (`src/sources/sqlite.ts`). No new dependency. Read-only mode still sees changes the tool hasn't checkpointed from its WAL yet.
- It's loaded lazily, once, and its "experimental feature" warning is silenced so it never lands in the TUI.
- On Node without it (22.12 needs a flag; it's unflagged from 22.13), or when the file is missing or has a layout we don't know, the source detects nothing and collects nothing. The minimum Node version stays 22.12.
- Queries select times, types, titles and folders only; message text isn't read beyond checking a prompt isn't empty.
- Tests build databases from `.sql` scripts in `test/fixtures/`, so fixtures stay reviewable text.

## Consequences

- If `node:sqlite` changes its API while experimental, these sources break quietly (they find nothing) rather than crash. `pnpm check` on Node 22 and 24 in CI catches it.
- ADR 0003 stands: Clockout's own store stays JSON.
