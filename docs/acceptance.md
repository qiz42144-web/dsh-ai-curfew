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

**How.** `node --test` — 58 cases, no Host required. They cover the duty cycle, the curve
landing exactly on every anchor, all three curve shapes, peak windows on weekdays, weekends,
statutory holidays, the wrap past midnight, the lights-out boundary at 03:00 and wake-up at
09:00, the time machine, session exemption, dry-run semantics, and duration parsing.

### The peak gate on real traffic, on the real clock

**How.** Left running unattended overnight and into a weekday morning — no `debugNow`, nobody
watching. On 2026-10-08 at 10:48, inside the 09:00–12:00 peak window, a session belonging to a
different workspace was short-circuited. Its own log shows the turn a user would have seen:

```
assistant/message  seq 33
  content: [{ "type": "text", "text": "。" }]
  usage:   { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 }
  stream:  an array
```

All three of that session's replies from the morning carry zero output tokens. The plugin's
journal recorded the matching decision — `action: short-circuit`, `state: off-duty`,
`reason: "2026-10-08 10:48 · peak hours"` — so the verdict and the durable message agree.

This also crosses the real 09:00 wake-up boundary on the way in, and the real 03:00 lights-out
boundary on the way out, both without a time machine.

**And it stands aside correctly the rest of the time.** Re-checked at 12:29, between the two
peak windows: a fresh session's `request/header` recorded `maxTokens: 131072` with
`adapterDefaults: { maxTokens: true }`, meaning the machine's own default was left untouched.

### The client half's surfaces are live

**How.** The client `Slots` inspection provider queries the running page, not a mock. It
reports `ai-curfew` among the occupants of `sidebar.footer.action` (order 60, active) and of
`settings.section` (order 40, active). Since the page only lists what it actually mounted, that
confirms the bundle was served, materialized, and ran both registrations — the part a shell
client cannot see, because the bundle route answers an unauthenticated request with 401/404.

**And the capsule renders the right verdict.** Observed in the running shell at 12:42 on a
Thursday, inside the 12:00–14:00 valley: the capsule read `🟢 上班中`. That is the correct
verdict for that moment, so the full chain is exercised end to end — the state route, the
connection trust fence, the client bundle, its poll, and the render.

### The client half's schedule band

**How.** `test/client.test.mjs` loads `client.js` through a stub `__ModuleLoader__` with a
minimal React, calls the registered settings component, and inspects the element tree it
returns. The band is asserted block by block against the same day: 00:00 is winding because the
window opened at 23:00, 03:00–08:45 is lights-out, 09:00–11:45 and 14:00–17:45 are off duty,
the middle of the day is on duty, and 23:00 closes the loop. Disabling the peak gate flattens
the morning. A missing schedule degrades to a flat band rather than throwing.

This is a fake-DOM test, not a browser test: it proves the classification and the element
shapes, not that the shell renders them.

### The `/curfew` subcommands

**How.** `test/command.test.mjs` drives the handler directly — it is a pure function of the
configuration, the file overlay, and whatever the previous command left in memory. Each branch
is asserted: `status` reports the verdict, the budget and the config path; a bare invocation
equals `status`; `now` forces lights-out and `on` hands the day back; `off` snoozes with a
default and rejects a malformed or zero duration; `debug` moves the clock, survives a full
timestamp, and refuses what it cannot parse; an unknown verb lists what is available.

The test suite is also what caught the status text reporting `winding · 560 tokens` while a
snooze was in force — the schedule's verdict, not the effective one. Both the command and the
capsule now report what will actually happen and keep the schedule as context.

What this does not cover is DSH's own plumbing from the composer to the handler.

## Not yet verified

| Item | Why it is outstanding | How to check |
|---|---|---|
| Typing `/curfew` reaches the handler | The subcommands are tested directly, but the composer-to-handler path is DSH's, and an agent cannot issue a slash command | Type `/curfew`, then `/curfew debug 01:30`, then `/curfew on` |
| The settings page as rendered pixels | The capsule is confirmed rendering (above) and the page is confirmed registered, but nobody has looked at the band itself | Open Settings and find the "AI 熄灯" page |
| The capsule changing state on its own | It polls once a minute, so a boundary crossing should flip it unattended — not yet watched across one | Watch the capsule at 14:00 on a weekday, or open the page at 23:00 |

Everything else has been observed on a live Host, including the peak gate acting on a real
session's traffic unattended.

## Known limits

- **Subagent classification leans on an undocumented shape.** `applyToSubagents: false` spares
  delegated sessions, and the classification is learned in `agent/request` from
  `agent.session.header.parentSession` / `.origin` — the same access a sibling plugin uses, but
  not part of the published `Agent` contract, which documents only `id`. Every access is guarded
  and a miss falls back to "treat it as a root agent", which is the default behaviour; the
  classification itself is covered by tests, but not against a live subagent.
- **The holiday table ends at 2026.** See [`PROVENANCE.md`](../PROVENANCE.md).
- **The client polls once a minute**, so a state change can be up to a minute stale while the
  host-side verdict is always current.
- **The band draws the weekday template**, not the actual date: weekends and statutory holidays
  are valley all day, and a schematic that shade-shifted per date would need the holiday table
  in the browser. The settings page says so.
