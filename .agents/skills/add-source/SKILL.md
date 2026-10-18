---
name: add-source
description: Add a new activity source to Clockout (a coding agent's session logs, a calendar, a code host, or any tool that records work). Use when asked to support a new tool as a data source or to read activity from somewhere new.
---

# Add a source

A source reads one tool's data for a date range and emits `Activity` records. It never decides projects, durations or summaries; `src/core/` does that.

## 1. Research the format

- Find where the tool stores data and in what format. Check `docs/research.md` first; it lists paths for many agents and calendars.
- Inspect real files on this machine for structure only (`ls`, `file`, `sqlite3 .schema`, `jq 'keys'`). Never read credential files.
- Note which fields give: timestamps, who acted (the user or an agent), working directory or repo, branch, a title.

## 2. Add fixtures

- Create synthetic files under `test/fixtures/<source-id>/` that mirror the real layout and field names.
- Cover: a normal day, a session crossing midnight, an empty day, and one malformed line.
- No real data from the user's machine.

## 3. Implement

- New folder `src/sources/<source-id>/` with `index.ts` exporting a `Source` (see `src/sources/types.ts`).
- `detect()`: return details if the tool is installed (path exists, CLI responds), otherwise `null`. Fast; no network.
- `collect(range, cfg)`: async-iterate `Activity` records inside the range. Validate each raw record with zod; skip and count invalid ones instead of throwing.
- Mark `actor: "human"` only for things the user did (prompts, commits, reviews, meetings).
- Register it in `src/sources/index.ts` and add its config shape to `src/config/schema.ts`.

## 4. Test

- `test/sources/<source-id>.test.ts` runs `collect` against the fixtures and snapshots the activities.
- `pnpm check` passes.

## 5. Document

- Add the source to the sources table in `docs/spec.md` and the README.
- Tick the item in `docs/plan.md`.
