# 0009. Change Clockout through config, not code

Status: proposed (2026-10-24)

## Context

Every company's timesheet is a little different: the columns it pastes, how it writes hours, the API it takes entries through. Today the export formats are fixed in `src/export/formats.ts` (date, project, task, hours, description; hours as `1.25`), and a timesheet system either runs next-pms or answers Clockout's own five requests ([timesheet-api.md](../timesheet-api.md)). Anything else means changing the source.

The person using Clockout should be able to say "add a Harvest export with hours as h:mm" or "send my day to our PMS, here are its API docs", and have an AI make that change without anyone editing Clockout. ADR 0002 and ADR 0007 already set how an AI changes things: it returns operations, Clockout checks them, the person confirms. What's missing is something for those operations to change.

## Decision

The parts people need to fit their own system become **declarative config**, with **settings operations** (ADR 0007) the AI can propose for them. The AI changes settings, never code and never `config.toml` directly. Four layers, in this order:

### 1. Export formats in config

`[[exports]]` defines named formats next to the built-in ones (csv, md, tsv, json), which stay as they are:

```toml
[[exports]]
name = "harvest"
type = "csv"                 # csv | tsv | markdown | json | text
merge = true                 # same work in one row (the default)
columns = [
  { field = "date", header = "Date", format = "dd/MM/yyyy" },
  { field = "project", header = "Client project" },
  { field = "hours", header = "Time", format = "h:mm" },
  { field = "description", header = "Notes" },
]

[[exports]]
name = "standup"
type = "text"
line = "{project}: {description} ({hours})"
```

- Fields are the row's own: date, project, task, hours, description, plus the ERP task when mapped. Formats are a fixed list (date patterns, hours as decimal / `h:mm` / minutes, rounding).
- Templates only fill in fields. No expressions, no conditionals, nothing evaluated.
- `clockout export --format harvest`, `/copy harvest`, and a default for Ctrl+Y.
- CSV/TSV keep the formula guard; a format can't turn it off.

### 2. A mapped HTTP target

`type = "api"` describes any timesheet API by mapping Clockout's five operations (read the day, search tasks, create, update, delete) onto its requests:

```toml
[timesheet]
type = "api"
url = "https://pms.example.com/api/v2"
token_env = "PMS_TOKEN"
auth = "Bearer {token}"              # or a header name and pattern

[timesheet.day]
request = "GET /time_entries?date={date}"
list = "time_entries"                # where the entries are in the answer
id = "id"
task = "task.id"
hours = "hours"                      # or minutes / seconds, with a unit
description = "notes"
locked = "is_locked"
```

- Paths into answers are plain dotted paths. Bodies are JSON templates of the same fields.
- The token only ever comes from `token_env`. It is never in config, in a template, or in what the AI sees.
- Same plan-then-apply as ADR 0006; the five-request `http` target becomes one fixed mapping of this.
- Fixed to https, as the other targets are (plain http only on this machine).

### 3. A mapped MCP target

`type = "mcp"` does the same for a system that offers an MCP server instead of (or as well as) an API. The five operations map onto its tools:

```toml
[timesheet]
type = "mcp"
url = "https://erp.example.com/mcp"   # streamable HTTP

[timesheet.day]
tool = "get_timesheet"
arguments = { date = "{date}" }
list = "entries"
id = "name"
task = "task"
hours = "hours"
description = "description"

[timesheet.create]
tool = "log_time"
arguments = { date = "{date}", task = "{task}", hours = "{hours}", description = "{description}" }
confirm = { tool = "confirm_write", arguments = { preview = "{result.preview_id}" } }
```

- A tool's answer is read from `structuredContent`, or else its text content parsed as JSON. `isError` is shown as that system's error, next to the row, like an API's `error`.
- `confirm` covers servers whose writes are a preview first and a confirmation second (rtCamp's ERP MCP works this way). Clockout makes the second call itself, because the person already confirmed the plan.
- Sign-in follows MCP's authorization spec: protected-resource metadata, then the same discovery, dynamic registration, PKCE and loopback as `src/oauth.ts`, with `clockout connect mcp <url>`. A fixed token can come from `token_env` instead.
- Clockout calls only the tools named in the mapping, and write tools only while sending a confirmed plan. Neither the AI nor the server decides what's called.
- The AI drafts the mapping from the server's `tools/list` (names, descriptions, input schemas), never from any tool's results. Tool descriptions come from the server and can say anything, so they're treated as data. The drafted mapping is still only a proposal, shown in full before it's saved.
- The client is written in Clockout (JSON-RPC over streamable HTTP: `initialize`, `tools/list`, `tools/call`), not taken from the MCP SDK. It's a small part of the protocol, and it avoids a new dependency. If it grows (sampling, resources, stdio sessions), the SDK gets its own ADR.
- Remote servers only from the chat bar. A local stdio server is a command to run, so it's set like layer 4.

ADR 0006's reasons for next-pms to use REST still hold: its MCP tools are generic and don't keep next-pms's rules. The `next-pms` target stays as it is. This layer is for systems whose MCP tools are the better way in.

### 4. A command escape hatch

`type = "command"` for a target or an export: Clockout runs a program you name, writes the request as JSON on stdin and reads JSON back, in the same shapes as the timesheet API. This covers what a mapping can't: a local stdio MCP server, a SOAP API, a spreadsheet on disk.

- **No AI operation can add, change or point at a command.** It's set in `config.toml` by hand or with `clockout` on the command line, after showing what will run. Settings proposals that touch it are refused.
- It runs without a shell, with a timeout, in its own process group, like the AI helpers.

### What the AI sees and can do

- Export formats: all of them, since they hold nothing private. Operations add, change and remove `[[exports]]`.
- The API mapping: its host, paths and field mappings, so it can draft one from pasted API docs and fix it from an error. Header values other than the token pattern stay out of the summary.
- The MCP mapping: the server's host, the mapped tools and arguments, and the server's tool list while drafting one. Tokens are never in what it sees.
- Everything is applied by pure functions and validated with the config schema, shown as a proposal, and saved on Enter, as in ADR 0007.

## Consequences

- No new dependency: MCP is a small JSON-RPC client over `fetch`, and sign-in reuses `src/oauth.ts`.
- What leaves the machine for an MCP target is what leaves for an API: the day's rows and task searches, to the person's own system, only when they confirm.
- MCP servers with tools too generic to map one-to-one (a single `create_document` for everything) may need the command layer, or a target of their own like next-pms.
- The config schema grows, and each new section needs settings operations, a summary for the AI and tests.
- APIs that want start and end times instead of hours (Clockify, Toggl) don't fit the mapping's first version; they use the command layer until there's a real need.
- A wrong mapping is caught before anything is written: Clockout reads the day first, and a read it can't make sense of stops the send with what didn't match.
- A command target is code the person trusts, outside Clockout's checks. That's why the AI can't set it.
