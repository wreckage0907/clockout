# 0005. A clickable terminal UI

Status: accepted (2026-10-21)

## Context

Clockout is for people who don't live in terminals too, and the review screen is now cards with buttons, a date picker and a setup dialog. Keyboard-only made those slow to learn. Ink 8 has no mouse support: it drops mouse reports before `useInput` sees them.

## Decision

- Turn on SGR mouse reporting (click, drag, motion) and run in the alternate screen, so screen rows match layout rows.
- Wrap stdin before handing it to Ink (`src/tui/mouse.ts`): mouse reports are pulled out and emitted as events; keys and pastes pass through untouched.
- `src/tui/clickable.tsx` routes events: `Clickable` boxes register themselves, hit-testing uses Ink's `measureElement`, the innermost box under the pointer wins, and an `Overlay` sits above the screen and closes when you click outside it.
- Everything clickable stays reachable by keyboard.

## Consequences

- No new dependency.
- While the app is open, the terminal's own drag-to-select needs Option or Shift held (as in other mouse-aware TUIs).
- Glyphs whose width terminals disagree on (`⚙`, `☰`, `⧉`) shift a line by a column; buttons use plain words.
