# Security policy

Clockout runs on your machine and keeps its data there: no server of ours, no telemetry. It does handle sensitive things, so reports are welcome: sign-in tokens (GitHub, Google, MCP, timesheet systems), private calendar addresses, and the activity of your day.

## Reporting a vulnerability

Don't open a public issue. Report it privately:

1. Open the [Security tab](https://github.com/wreckage0907/clockout/security) of this repository.
2. Click **Report a vulnerability** and describe what you found, the Clockout version (`clockout --version`) and how to reproduce it.
3. Leave out real tokens, session logs and calendar data. Redact them or use synthetic ones.

You'll get a first answer within a week. A fix is released as a new version, and the report is credited unless you'd rather it wasn't.

## What counts

- A token, a private calendar address or a prompt leaving your machine where it shouldn't: in a log, an export, a prompt to an AI helper, or a request to anywhere other than the service you configured.
- A file holding a secret (`config.toml`, `credentials.json`) written readable by other users.
- A setting, a command target or an AI answer that makes Clockout run something you didn't configure.
- Anything that lets a web page or another local user reach the sign-in listener on `127.0.0.1`.

## Supported versions

Only the latest release gets fixes.
