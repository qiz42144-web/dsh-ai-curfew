# Architecture

How ai-curfew sits on DSH's model call path, and why each choice is the one it is. Every
claim here was checked against a running Host rather than inferred from documentation; the
exact signatures are in [`dsh-contracts.md`](dsh-contracts.md).

## The shape

Two independent gates, and the harsher one wins:

```
A. peak / valley shift   peak hours → no request at all, one canned reply
B. curfew curve          curfewStart → lightsOut: the reply budget shrinks 2048 → 64
                         lightsOut → wakeUp:   no request at all, one canned reply
```

Severity is `max(A, B)` over four states — `on-duty` < `winding` < `off-duty` < `lights-out` —
so a peak hour during the curfew answers with the off-duty line, and lights-out outranks both.
The whole decision is one pure function, `resolveDuty(now, config)`, which is why the behaviour
table can be asserted without a Host (`test/duty.test.mjs`).

## Five gates

| Hook | Why here |
|---|---|
| `llm/stream` | The only place a turn can be answered without a request. Yielding your own chunks short-circuits the waterfall, so no adapter is reached. |
| `agent/request` | The only place `maxTokens` can be changed. `llm/stream` receives a deep-frozen request whose content is a pure function of the session log, and rewriting it throws. |
| `system-prompt/assemble` | The documented expert hook over the assembled prompt. |
| `tools/pre-execute` | Stops a turn that is already running from starting new work across the boundary. |
| `webServer` + `commands` | The status route and `/curfew`. Neither reaches the model. |

## Why the off-duty reply short-circuits the stream

The obvious alternative is `agent/pre-step`: reject the step and write your own reply into the
session. It is the wrong tool here, for two reasons.

**A rejection produces no reply at all.** The requirement is "still receives the message, just
answers with a full stop". A rejected step leaves the user looking at a turn that vanished.

**Writing the session event yourself is a trap.** A sibling plugin, AIQuit, documents this in
its own changelog: an `assistant/message` event it hand-wrote was missing a `stream` field, and
`dsh-token-meter` reads exactly that field when a settlement carries no `usage`:

```js
// dsh-token-meter
function usageOf(event) {
  if (event.type === 'assistant/message' && event.data.usage !== undefined) return event.data.usage
  return lastAssistantStreamChunk(event.data.stream, 'usage')?.usage   // ← needs data.stream
}

// dsh-llm
function lastAssistantStreamChunk(stream, type) {
  for (let index = stream.length - 1; index >= 0; index -= 1) { … }    // ← throws on undefined
}
```

The result was not a missing counter. The session's history failed to load, permanently, and
upgrading the plugin could not repair the events already written.

By short-circuiting the stream instead, DSH writes the event and every required field is
present by construction. The reply is a real assistant message because the agent loop
assembles it from our chunks — we never touch the log.

Two further consequences fall out of the same choice:

- **The zero is real.** No provider request is made, so the turn genuinely costs nothing.
  We still send an explicit zero `usage` chunk: it keeps `usageOf` on its first branch, and it
  makes "costs nothing" a line in the ledger rather than an absent field.
- **Tool calls cannot leak.** The synthetic message contains one text block and no tool calls,
  so the loop returns `completed` and the turn ends cleanly.

## The synthetic stream's exact shape

```
block-start  { index: 0, blockType: 'text' }
text-delta   { index: 0, text: '。' }
block-end    { index: 0, block: { type: 'text', text: '。' } }
usage        { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
finish       { reason: { kind: 'stop' } }
```

The assembler is tolerant — it handles delta-only protocols, and a missing `finish` defaults to
`{ kind: 'stop' }` — so the minimum would be the single `text-delta`. The explicit form is kept
because it is what a well-behaved adapter emits, and because `finish.kind === 'stop'` is what
makes the loop commit an `assistant/message` rather than an `assistant/attempt`.

## Events reach ancestors, not siblings

This one cost real debugging time and is worth stating plainly.

Cordis delivers an event to the context it is emitted from **and that context's ancestors**. A
listener registered on a plugin's own context therefore sees events emitted at or above the
root — and nothing emitted on a sibling branch.

- `llm/stream` is emitted from the `LlmRuntime` service, so a plugin-context listener receives
  it. This masked the problem during early testing.
- `agent/request`, `tools/pre-execute`, and `system-prompt/assemble` are emitted with an
  **agent-scope target**, which is a sibling branch. A plugin-context listener never sees them,
  and nothing about the failure is loud: the hook simply never runs.

`apply()` therefore resolves `const events = ctx.root ?? ctx` and registers every scoped hook
there, while `ctx.effect` still ties their disposal to the plugin's fiber.

The symptom to recognise: a gate that reports success and changes nothing. `agent/request` was
verified by comparing two sessions that differed only in the exemption list — one logged
`maxTokens: 2048` with `adapterDefaults: null`, the other `131072` with
`adapterDefaults: { maxTokens: true }`. A hook that never runs and a hook that declines look
identical from the outside; only a control group separates them.

## The budget belongs to `agent/request`

`llm/stream` receives a request a loop built, and it arrives deep-frozen: its content is a pure
function of the session log, so listeners read it and never rewrite it. Anything that changes
what is sent has to happen earlier.

`agent/request` hands over the config the machine *would* use and accepts a replacement. The
clamp is always `Math.min`, never a raised budget, and it is applied only where the plugin has
an opinion:

- `winding` — the curve's value for this instant.
- `off-duty` / `lights-out` — nothing, by default. The stream gate is already answering these
  turns; see the safety-cap note below.
- `on-duty` — nothing at all, so a normal day is untouched.

`maxTokens` may be `undefined`, meaning "use the adapter's default". A curve that only clamped
existing values would do nothing on a default configuration, so the budget is always set
explicitly.

## Why the persona goes through the waterfall

`systemPrompt.section()` looks like the natural fit and does not work from a plugin. The
service registers into the layer of **its own** context, and `assemble()` merges sections per
scope:

```js
const sectionByName = this.layers.merge(scope, (layer) => layer.sections)
```

A section registered that way never reached an agent's prompt — confirmed by searching a
subagent's logged `system/message` for the injected text and finding nothing.

The `system-prompt/assemble` waterfall is dispatched with a scope target, so it is reachable
from the root exactly like the two hooks above, and it can append to the assembly directly.
Outside the curfew the assembly is returned untouched, so the hook costs one predicate and no
prompt tokens.

## Failure modes designed around

**A too-small token cap is worse than no cap.** The first version carried
`safetyMaxTokens: 16`, intending it as a net for the case where the stream gate somehow let a
request through. It produced this instead:

```
Command Code reached the output token limit without producing answer text or a tool call
(finish_reason=length, max_tokens=16, outputTokens=16, reasoningTokens=16)

OUTPUT_TOKEN_LIMIT
```

16 tokens is spent entirely on reasoning before any text exists, and the provider fails the
turn. The cap is now `null` by default: the stream gate is the mechanism, and a second cap in
the same states only adds a way to fail. It remains available as an explicit opt-in, sized for
the model's reasoning budget rather than for the expected reply.

**A dry run must not act.** `/curfew debug` and `dryRun` exist so the schedule can be exercised
without consequence. `clampMaxTokens` returns `null` outright when `dryRun` is set, so a dry
run reports a verdict without changing what the machine would send.

**A service captured once during `apply()` may not be the one that serves.** The status route
was originally registered against `ctx.get('webServer')`, resolved at apply time. On a cold
start the capsule then sat on its fallback text forever, while toggling the plugin fixed it —
because a toggle re-applies against the live service.

The tell was in the timestamps rather than the code. The plugin's own load marker showed an
`apply()` at 12:26 in a process that had started at 10:45, meaning the working capsule had been
a **re-apply**, not a boot. The rule that fell out of it:

> A service looked up once with `ctx.get()` during `apply()` is only correct if it is already
> installed *and never replaced*. Where that is not guaranteed, the registration has to be
> reactive.

So the route and the command now go through Cordis's own dependency injection, and the trust
fence is resolved per request:

```js
ctx.inject(['webServer'], (scope) => {
  scope.effect(() => scope.webServer.register({ kind: 'exact', path: STATUS_ROUTE, handler }))
})
```

`ctx.inject` runs the callback once the dependency is available and re-runs it if the service is
replaced, which covers both halves of the problem. Declaring `inject: ['webServer']` on the
plugin itself would not do: a missing service would hold the whole fiber in a pending state and
take the gates down with it, which is the opposite of what an optional UI route should cost.

The client half was hardened for the same reason — a poll that comes back empty or throws now
retries in seconds instead of waiting the full polling interval, so a boot race heals on its own
rather than depending on the user to toggle something.

## Developing against a running Host

A running DSH process caches plugin ES modules **by resolved URL**, and disabling and
re-enabling a Loader entry re-runs `apply()` without re-importing the module. Editing source in
place therefore changes nothing until the process restarts, which makes for a slow loop.

`scripts/dev-reload.ps1` works around it without touching plugin code: it copies the package to
a fresh revision directory and re-points the `dsh-ai-curfew` junction in the profile's
`node_modules` at it, so the module URL is one no process has loaded. One disable/enable toggle
then imports the new revision.

Two things that do **not** work, recorded so nobody repeats them:

- Configuring the `hmr` entry's `root` in the profile patch has no effect. It is read at launch,
  and even with a restart behind it, editing a source file did not trigger a reload.
- Removing a bundle from `dsh.profile.bundles` unloads its entry live, but adding it back does
  not restore it: the Loader cannot reconcile the entry while running, and Plugin Manager then
  reports `ambiguous-install`. A restart is the only way back.
