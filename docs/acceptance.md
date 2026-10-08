# Acceptance

What has been verified against a running Host, how, and what has not. Kept honest on purpose:
a gate that silently never runs looks exactly like a gate that declines, so each row names the
observation that would have distinguished them.

## Verified

### The off-duty reply is a real message and costs nothing

**How.** With the clock pinned past lights-out, a subagent was asked for a single word and
answered `明天再说。`. Its session log was then decoded frame by frame:

| Field | Value |
|---|---|
| `message.content` | `[{ type: 'text', text: '明天再说。' }]` |
| `usage` | `{ inputTokens: 0, outputTokens: 0, totalTokens: 0 }` |
| `stream` | an array of 5 records: `block-start, text-chunks, block-end, usage, finish` |
| lifecycle | `turn/start → step/start → … → assistant/message → step/end → turn/end` |

Every field whose absence has broken a session's history elsewhere is present, `stream`
included, and the message is committed by DSH rather than written by this plugin.

### The reply budget follows the curve

**How.** Two sessions issued a request at the same instant and differed only in whether they
were listed in `exemptSessions`. Their logged `request/header` configs:

| Session | `maxTokens` | `adapterDefaults` |
|---|---|---|
| exempt | `131072` | `{ maxTokens: true }` — the machine's own default, untouched |
| not exempt | `2048` | `null` — set explicitly by this plugin |

`2048` is the 23:00 anchor, so the curve reached the request rather than merely being computed.
The control group matters: without it, "the hook declined" and "the hook never ran" are
indistinguishable.

### The tired persona reaches the prompt

**How.** The subagent's logged `system/message` was searched for the injected line. Its system
prompt ends with:

```
Your working directory is <workspace>.

可以正常回答，但不要主动扩展话题。
```

That is band 0 of `tierTexts`, which is what a 23:00 verdict should select.

### The schedule itself

**How.** `node --test` — 43 cases, no Host required. They cover the duty cycle, the curve
landing exactly on every anchor, all three curve shapes, peak windows on weekdays, weekends,
statutory holidays, the wrap past midnight, the lights-out boundary at 03:00 and wake-up at
09:00, the time machine, session exemption, dry-run semantics, and duration parsing.

### The client half's schedule band

**How.** `test/client.test.mjs` loads `client.js` through a stub `__ModuleLoader__` with a
minimal React, calls the registered settings component, and inspects the element tree it
returns. The band is asserted block by block against the same day: 00:00 is winding because the
window opened at 23:00, 03:00–08:45 is lights-out, 09:00–11:45 and 14:00–17:45 are off duty,
the middle of the day is on duty, and 23:00 closes the loop. Disabling the peak gate flattens
the morning. A missing schedule degrades to a flat band rather than throwing.

This is a fake-DOM test, not a browser test: it proves the classification and the element
shapes, not that the shell renders them.

## Not yet verified

| Item | Why it is outstanding | How to check |
|---|---|---|
| `/curfew` is registered and behaves | Commands are invoked from the UI, not by an agent | Type `/curfew`, then `/curfew debug 01:30`, then `/curfew on` |
| The capsule and settings page render in the shell | Requires a browser; the bundle route is behind the connection trust fence and answers a shell client with 401/404 even for known-good DSH routes | Look at the sidebar foot, then open Settings |
| Peak/valley gate against the real clock | Exercised through `debugNow` and, for lights-out, on the real clock — but not yet across a real 09:00 boundary | Leave it running into a weekday morning |

## Known limits

- **`applyToSubagents` is not implemented.** The intended knob would exempt subagent sessions,
  but `llm/stream` and `agent/request` see a session id, not a session. A subagent's session
  header does record `origin: 'subagent'`, so the classification is possible — it needs a
  registry keyed by session id, which is not built yet. For now every session is gated except
  those named in `exemptSessions`.
- **The holiday table ends at 2026.** See [`PROVENANCE.md`](../PROVENANCE.md).
- **The client polls once a minute**, so a state change can be up to a minute stale while the
  host-side verdict is always current.
- **The band draws the weekday template**, not the actual date: weekends and statutory holidays
  are valley all day, and a schematic that shade-shifted per date would need the holiday table
  in the browser. The settings page says so.
