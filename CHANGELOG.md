# Changelog

## 0.1.0 — unreleased

First working version. Behaviour, in the order it was verified against a running Host.

### Off-duty replies

- `llm/stream` short-circuit: while off duty or after lights-out, the turn is answered from a
  synthetic chunk stream. No provider request is made, so it costs zero tokens and returns in
  milliseconds, and the agent loop still commits a real `assistant/message`.
- The synthetic stream sends an explicit zero `usage`, so the ledger records zero rather than
  recording nothing.
- `purpose`-tagged calls (compaction, session titles) always pass through.

### The curfew

- `wakeUp` / `curfewStart` / `lightsOut` define a four-phase day. The window wraps midnight.
- The reply budget shrinks along an anchor table from 2048 to 64, with `linear` (default),
  `step`, and `easeIn` shapes, applied through `agent/request`. A budget the machine already
  chose smaller is never raised.
- A tired-persona line is injected through the `system-prompt/assemble` waterfall, one band
  per quarter of the window, so a short reply reads as tired rather than truncated.

### The peak gate

- Monday–Friday 09:00–12:00 and 14:00–18:00 are off duty, minus weekends and statutory
  holidays. Can be disabled to leave a pure curfew plugin.

### Control

- `/curfew status | on | off <duration> | now | debug <time> | debug clear`.
- `$DSH_HOME/dsh-ai-curfew/config.json` is re-read whenever it changes; `/curfew` overrides
  layer over it in memory only.
- A sidebar capsule shows the current verdict, and a settings page draws the configured day as
  a 24-hour band. Both read `/ai-curfew/state.json`, behind the Host's connection trust fence.

### Notes

- `safetyMaxTokens` defaults to `null`. A 16-token cap on a reasoning model is spent entirely
  on reasoning, so the provider returns neither text nor a tool call and fails the turn with
  `OUTPUT_TOKEN_LIMIT`; the stream gate is the mechanism, and a second cap only adds a
  failure mode. See `docs/architecture.md`.
- Tool calls are denied while off duty, so a turn already running cannot start new work
  across the boundary.
- `applyToSubagents` (default `true`) gates delegated work as well; set it to `false` to let
  subagents finish while the front desk is closed.
