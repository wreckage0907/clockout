# 0013. Timesheet systems speak one API; no ERP is built into the CLI

Status: accepted (2026-10-28). Supersedes in part [0006](0006-send-to-timesheet-system.md): the `next-pms` target and its OAuth sign-in.

## Context

ADR 0006 made Frappe's next-pms the first timesheet target: its REST methods, signed in to with OAuth (discovery, dynamic client registration, PKCE, a rotating refresh token in `credentials.json`), through `clockout connect erp <url>`, a Setup section, a `/connect erp` command and a `connect` setting operation. Since then two generic targets arrived: `http` (any server answering Clockout's five-request JSON API, [timesheet-api.md](../timesheet-api.md)) and `command` (a program you name, ADR 0009).

Keeping one company's ERP in the CLI means several hundred lines of Frappe-specific code, a second sign-in flow to keep working, and a product that looks like it is for one employer. Anything next-pms can do, a small service in front of it can do through the generic API, and that service can live next to the ERP, where its rules and its sign-in belong.

## Decision

- **The `next-pms` target is removed**: `src/targets/next-pms/`, `clockout connect erp` / `disconnect erp`, the ERP sign-in in the review screen, in Setup and in the slash commands, the `erp` service of the `connect` / `disconnect` setting operations, and the `erp` entry in `credentials.json`. A leftover `erp` key in an old `credentials.json` is ignored and dropped the next time the file is written.
- Timesheet systems are reached two ways only: **`type = "http"`** and **`type = "command"`**. Plan, then apply (ADR 0006), the `[[timesheet.map]]` task mapping, the review screen's Ctrl+S and `clockout push` are unchanged and work through either.
- **A token can live in `config.toml`**: `[timesheet] token = "…"` beside the existing `token_env`. Use one of them. Neither means the environment variable `CLOCKOUT_TIMESHEET_TOKEN`, as before. `config.toml` is written readable only by you (Clockout also tightens the mode of an existing file when it saves), but it now holds a secret: don't commit or share it. `token_env` stays for anyone who would rather keep the token out of the file.
- **The token is hand-set only.** No settings operation (chat, AI or Setup) can set, change or read the token or the target's address; the AI's settings summary holds only the host and the task mappings, never the address's path or the token. Setup shows where days go and, when the token is missing, which variable to set or that `token = "…"` can go in the file; it has no field for either.
- **The token is never printed.** It is not in `--dry-run`, not in error messages (a server that echoes it back has it blanked out), not in the error log, and a syntax or schema problem in `config.toml` doesn't quote it back.
- **An old config with `type = "next-pms"` stops with a readable message** instead of a schema error: it says the target was removed and what to write instead (`type = "http"`, see docs/timesheet-api.md, or `type = "command"`, or delete the section). Failing is chosen over quietly dropping the section, because the next save would otherwise delete the user's `[[timesheet.map]]` entries.
- `erp` is no longer a reserved name for an `[[mcp]]` server.

## Consequences

- People who used next-pms need a small service in front of it that answers the five requests (or a `command` program). Frappe's API key or session handling then lives in that service, not in Clockout.
- One less browser sign-in, one less credential to refresh and revoke, and no Frappe-specific error text.
- `ERP` stays in a few labels (the Setup section, "Send to ERP") as the plain word for "your timesheet system".
- Reverses a line in the earlier docs ("the token itself never goes in this file"): it can now, by choice, in a file that is already kept private.
