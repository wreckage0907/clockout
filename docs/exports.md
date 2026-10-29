# Exports and destinations

The day's exports: built-ins at `clockout export -f` (`csv`, `md`, `tsv`, `json`), named formats of your own, and places a text can be written to besides the clipboard.

## Your own export formats

When your timesheet wants other columns, add a named format to `config.toml`, or say it in
the chat bar ("add a Harvest export with hours as h:mm", "make it what ctrl+y copies"):

```toml
[[exports]]
name = "harvest"
type = "csv"                 # csv | tsv | markdown | json | text
merge = true                 # the same work in one row (false: one row per block)
default = true               # what Ctrl+Y and a bare /copy use
columns = [
  { field = "date", header = "Date", format = "dd/MM/yyyy" },
  { field = "project", header = "Client project" },
  { field = "hours", header = "Time", format = "h:mm" },   # decimal | h:mm | minutes | hm
  { field = "description", header = "Notes" },
]

[[exports]]
name = "slack"
type = "text"
line = "{project}: {description} ({hours})"
```

Fields are `date`, `project`, `task`, `hours`, `description`, `erp_task` and `erp_task_name`.
Dates take a pattern of `yyyy yy MMMM MMM MM M dd d EEEE EEE`; hours as decimal take
`decimals` (0–4). Templates only fill in fields. Use them with `clockout export -f harvest`
or `/copy harvest`. CSV and TSV cells that look like spreadsheet formulas are always kept as
text.

## Where exports go

An export can say where its text also goes — a daily note in your vault, or a tool on an MCP
server — and Clockout shows the text and the place before writing:

```toml
[[exports]]
name = "daily-note"
type = "markdown"
to = { file = "~/Vault/Daily/{date}.md", append = true }

[[exports]]
name = "notion"
type = "markdown"
to = { mcp = "notion", tool = "append_block", arguments = { content = "{text}" } }
```

```sh
clockout export -f daily-note --dest          # asks first
clockout export -f daily-note --dest --dry-run
clockout standup --to daily-note              # the standup, into the same note
```

`{text}` and `{date}` are the only things filled in. A file path is set by hand (or in Setup),
never by the AI; replacing a note that's there is a question. Your own program can take the text
too: `to = { command = ["my-writer"] }` gets `{ date, format, text }` as JSON on stdin.
