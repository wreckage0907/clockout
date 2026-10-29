# Troubleshooting

## When a source doesn't answer

A source that fails never stops the day: it is drafted from the rest, and the review screen
shows a ⚠ line. Click it or type `/problems` for each message in full with its fix (sign in
again, turn on the Calendar API, authorize a token for your organization's SSO…). The
underlying errors are kept in `~/.local/share/clockout/errors.log`, on your machine only,
with anything that looks like a token redacted. Google sign-in problems are listed in
[google-setup.md](google-setup.md#troubleshooting).

## Without an AI helper

Without an AI helper, Clockout says so when it opens. The cards, `/` commands and exports
all work; only typed corrections and AI descriptions need one.

## A damaged saved day

If a saved day is damaged (`The saved day … is damaged`), move that file aside and open the
day again: it's rebuilt from your activity, without the corrections made on it.

## Node too old

On Node older than 22.12, Clockout says so and stops; update Node. Use 22.13+ for the opencode
and Antigravity sources (their databases need the unflagged `node:sqlite`).
