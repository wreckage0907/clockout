# 0002. AI through the user's own agent CLI

Status: accepted (2026-10-18)

## Context

Clockout needs an LLM for summaries and for turning spoken corrections into edits. Most developers already pay for a coding-agent subscription; asking for a pay-per-token API key adds cost and friction. Anthropic doesn't allow third-party tools to use Claude.ai subscription credentials or the Agent SDK on a subscription, but does allow a user's own unmodified `claude` binary signed in with their own subscription.

## Decision

The MVP backend shells out to the user's installed `claude -p` with `--output-format json --json-schema`, tools off, no session persistence, in an empty temp dir. Clockout never reads or stores any vendor's credentials. A heuristic fallback works with no AI at all. Other backends (Codex, Copilot, Ollama, API key) come later behind the same `LlmBackend` interface.

## Consequences

- No API key needed for the MVP user.
- Each call has CLI start-up latency, so the whole day goes in one call.
- Usage counts against the user's plan limits; keep calls few and small.
