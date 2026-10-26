# 0011. Remember what people say

Status: accepted (2026-10-26)

## Context

Clockout already has settings for most preferences: how descriptions read (`[descriptions]`), how a
standup reads (`[standup]`), project rules, task names, export formats, and the AI changed them
from the chat bar ([ADR 0007](0007-setup-from-the-chat-bar.md), [ADR 0009](0009-change-clockout-through-config.md)).
What's left over is the small stuff that has no setting: "the reader of my timesheet isn't
technical", "we spell it *frontend*", "never mention the client's name in a standup". Said once,
it should stick, without a new schema field for every possible preference and without the person
repeating it every day.

This is the "saving repeated corrections as rules" idea from the spec's stretch list, narrowed to
what can ship safely: words handed to the AI, not a new rule engine.

## Decision

- **A memory is a line of text you gave.** `memories = ["Ticket keys come first"]` in
  `config.toml`, at most 20, each up to 200 characters. Nothing else: no tags, no per-source
  scoping, no logic. A preference that is really a setting (a style, a rule, a task name, a
  limit) stays a setting, and the AI is told so.
- **The AI keeps them, and only through settings operations.** `remember` adds one in your words,
  shortened to a line; `forget` removes one, by its own words or a part of them. Both are
  proposed, shown in the panel, and saved on Enter like every other settings change. Nothing is
  remembered by a source, by a background job, or by a command you didn't confirm.
- **Where they go:** the descriptions prompt, the standup prompt, and the settings prompt (which
  also lists them, so "forget the ticket key one" works). Never into a source, a timesheet row, an
  export, or a push.
- **Never a secret, never a path.** A memory that looks like a token or a key is refused with why
  ("That looks like a password or a token, so Clockout didn't remember it"), using the same
  `hasSecret` check that guards prompts and exports. A memory is one line, cleaned like any other
  text that reaches the screen or a prompt.
- **They change the cache key.** Descriptions are cached per block's evidence; the memories are
  part of that key, so changing what you remember writes the day's descriptions again. The same
  style rule as `[descriptions]`.
- **You can see and remove them.** Setup → AI helper lists them under "Remembered", each with
  "✕ forget", and the chat bar says the rest ("remember …", "forget …").

## Consequences

- The config gains one key, and `applySettings` two operations. Setup gains a list. No new
  dependency, no new process, no new file.
- Memories multiply: a wrong one shapes every description until it's forgotten. That's why they're
  visible in Setup, in the AI's editing prompt, and capped at 20 short lines.
- The AI can't use a memory to smuggle in a path or credential, and can't point one at a file,
  a command or a server: those are refused or aren't settings at all ([ADR 0009](0009-change-clockout-through-config.md)'s
  command rule holds here too).
- A memory is prompt text, so it's advisory, not enforced. Anything that must be enforced is a
  real setting (an `ignore` rule, a task mapping, an export format), and the AI is told to prefer
  those.
