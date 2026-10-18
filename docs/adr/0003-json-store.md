# 0003. JSON files for local storage

Status: accepted (2026-10-18)

## Context

Clockout must keep drafted days and corrections, partly because Claude Code deletes transcripts after ~30 days. `better-sqlite3` is a native addon that needs prebuilt binaries for every Node release or a compiler toolchain. `node:sqlite` is still experimental on Node 22.

## Decision

Store days and corrections as JSON files under `$XDG_DATA_HOME/clockout` (default `~/.local/share/clockout`), behind a small `Store` interface.

## Consequences

- No native dependencies; `npx` installs stay fast and portable.
- Queries across many days are slower; revisit with `node:sqlite` once it's stable on the minimum Node version.
