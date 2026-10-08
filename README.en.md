# AI Curfew

[中文](README.md) | English

**Turns "the AI is always on" into "the AI clocks off too".**

After curfew its replies get shorter and shorter, the overnight `max_tokens` budget slides from
2048 down to 64, and past 3am it answers with a single "明天再说。" *("we'll talk tomorrow")*.
Peak billing hours are off duty, valley hours are on duty, and while it is off the clock it
still receives your message — it just answers with one full stop.

> The point is not that the model *acts* tired. It is that it actually stops: while off duty
> **no API request is sent at all** — zero tokens, zero cost, milliseconds.

![node >=22](badges/node.svg)
![platform DeepSeek Harness](badges/platform.svg)
![dependencies none](badges/dependencies.svg)
![tests node --test](badges/tests.svg)
![off-duty cost 0 tokens](badges/cost.svg)
![license MIT](badges/license.svg)

```
on-duty ──────────→ winding ──────────────→ off-duty ─────────→ lights-out
(full budget)       maxTokens 2048 → 64     replies "。"        replies "明天再说。"
```

## Behaviour

| Moment | Verdict | Reply |
|---|---|---|
| Tue 10:00 | peak hours | `。` |
| Tue 20:00 | valley, before curfew | works normally |
| Tue 23:30 | curfew, winding | short reply, budget ≈1824 |
| Wed 01:30 | curfew, winding | one sentence, budget ≈560 |
| Wed 02:30 | curfew, winding | 20 characters max, budget ≈192 |
| Wed 03:10 | past lights-out | `明天再说。` |
| Sun 14:00 | weekends are valley all day | works normally |

Two independent gates, and the harsher one wins:

- **A. Peak/valley shift** — nobody home during peak billing hours (Mon–Fri 09:00–12:00 and
  14:00–18:00, minus weekends and Chinese statutory holidays)
- **B. The curfew curve** — the budget follows an anchor table from 2048 down to 64, then goes
  dark at 03:00

Gate A can be switched off on its own, leaving a pure curfew plugin.

## Install

```sh
dsh plugin --profile <your profile> add link:/absolute/path/to/ai-curfew
```

The Host half takes effect immediately; the client half (a status capsule at the sidebar foot
and a schedule page in Settings) is served from `/plugins`.

## Configuration

Configuration lives in `$DSH_HOME/dsh-ai-curfew/config.json` and is **re-read whenever it
changes** — no restart. Write only the keys you want to change:

```json
{
  "curfewStart": "23:00",
  "lightsOut": "03:00",
  "wakeUp": "09:00",
  "peakShift": true,
  "offDutyReply": "。",
  "lightsOutReply": "明天再说。",
  "debugNow": "01:30"
}
```

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | master switch |
| `timezone` | `Asia/Shanghai` | the schedule is read in this zone |
| `wakeUp` / `curfewStart` / `lightsOut` | `09:00` / `23:00` / `03:00` | the day's four phases; the window wraps midnight |
| `anchors` | 23:00→2048 … 03:00→64 | the budget table, `[time, tokens]` |
| `curve` | `linear` | `linear` (between anchors) / `step` / `easeIn` (holds, then plunges) |
| `peakShift` / `peakWindows` / `weekendValley` / `holidays` | on / 9-12,14-18 / on / 2026 table | the peak gate |
| `offDutyReply` / `lightsOutReply` | `。` / `明天再说。` | what is said when nothing is sent |
| `tiredPersona` / `tierTexts` | on / four bands | the tiredness line injected into the prompt, one band per quarter of the window |
| `denyToolsWhenOffDuty` | `true` | stop running tools once off duty |
| `applyToSubagents` | `true` | whether delegated subagents are gated too |
| `windingReasoningEffort` | `null` | optional: drop to a given reasoning-effort id during the curfew |
| `dryRun` | `false` | decide and record, but still send the request |
| `debugNow` | `null` | time machine: `HH:MM` or `YYYY-MM-DD HH:MM` |
| `exemptSessions` | `[]` | session ids to leave completely alone |
| `safetyMaxTokens` | `null` | see below; off by default |

### Commands

```
/curfew                    the roster: current verdict, budget and reasoning
/curfew overtime 30m       order 30 minutes of overtime (curfew suspended)
/curfew off                clock off right now
/curfew auto               back to the automatic roster (drops every override)
/curfew debug 01:30        move the clock, to try any hour
/curfew debug clear        back to the real time
```

Commands never reach the model, which is what makes this the way out when the AI has already
locked itself out. (Command output is in Chinese.)

**Why "overtime" and not "leave".** "Leave" makes the AI the subject — as if it were asking for
time off. What `/curfew overtime` actually does is *you ordering it to work*. In the same
spirit, `off` now means one thing only: the AI clocks off.

### About `safetyMaxTokens`

Off by default, deliberately. The stream gate is what keeps an off-duty turn from reaching the
provider, so a second cap is redundant wherever it would help — and harmful where it would not.
A reasoning model spends a small budget entirely on reasoning, so the provider receives neither
text nor a tool call and fails the whole turn:

```
Command Code reached the output token limit without producing answer text or a tool call
(finish_reason=length, max_tokens=16, outputTokens=16, reasoningTokens=16)  [OUTPUT_TOKEN_LIMIT]
```

If you want a hard ceiling anyway, size it for the model's reasoning budget, not for the reply
you expect.

## How it works

The off-duty reply **short-circuits the `llm/stream` waterfall** with a synthetic chunk stream.
Nothing is sent over the network. It is not an `agent/pre-step` rejection — that would leave the
turn with no reply at all, which reads as "the AI died" rather than "the AI is off duty". A real
assistant message has to exist, so the agent loop assembles one from our chunks and commits it
itself; we never touch the session log.

The full design, the traps, and why hand-writing the session event is a bad idea are in
[`docs/architecture.md`](docs/architecture.md); the DSH contracts this relies on, as read out of
a running Host, are in [`docs/dsh-contracts.md`](docs/dsh-contracts.md).

## Development

```sh
node --test          # zero dependencies; the behaviour table is the assertion
```

Every decision is a pure function (`duty.js`, `clock.js`), so the whole schedule is testable
without a Host.

The badges are **committed SVG**, regenerated with `node scripts/make-badges.mjs`. They are not
shields.io URLs: a README should not depend on a third-party image proxy to render, and for
readers where that proxy is unreachable the badges would simply be broken pictures.

**Editing the source has no effect until DSH restarts.** A running process caches plugin ES
modules by resolved URL, and disabling and re-enabling an entry re-runs `apply()` without
re-importing. `scripts/dev-reload.ps1` works around it by publishing a fresh revision directory
and re-pointing the profile's junction, which costs one disable/enable. Why the HMR route does
not work is recorded in
[`docs/architecture.md`](docs/architecture.md#developing-against-a-running-host).

## Status

**Unreleased.** [`docs/acceptance.md`](docs/acceptance.md) records what has been verified against
a live Host, how, and what has not.

## Licence and provenance

MIT. The sources, credit, and the annual maintenance the peak/valley and holiday data requires
are in [`PROVENANCE.md`](PROVENANCE.md).
