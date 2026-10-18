# 0001. Terminal UI with Ink

Status: accepted (2026-10-18)

## Context

Corrections happen by voice: Wispr Flow pastes dictated text into whatever has focus. Coding-agent logs live in local dotfolders, which a hosted web app can't read. Judges must run it with `npx`.

## Decision

The main interface is a terminal UI built with Ink 8 (React for terminals, used by Claude Code). Plain CLI output (`--md`, `--json`) for scripting. No web UI in the MVP.

## Consequences

- Runs with plain `npx` on Node ≥ 22. OpenTUI was rejected because it needs Bun or Node ≥ 26 with an experimental flag.
- Dragging and resizing blocks isn't possible; voice corrections replace it.
- The input must use bracketed paste so dictated text is never read as hotkeys.
