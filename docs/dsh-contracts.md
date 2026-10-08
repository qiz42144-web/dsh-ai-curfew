# DSH contracts this plugin relies on

Notes taken against a running Host, not copied from upstream documentation. Every signature
below was read out of the live runtime with the Cordis inspection tools
(`cordis_inspect_list` / `cordis_inspect_query`), and the behavioural claims were checked
against DSH's own bundled sources.

The upstream packages are published publicly (`@deepseek-ai/dsh-*` on npm, permissively
licensed); this file exists so the plugin does not depend on a snapshot of their READMEs going
stale inside this repository.

## Events

All four are **waterfall**: call `next()` to continue, or return your own value to replace the
result.

| Event | Signature | Notes |
|---|---|---|
| `llm/stream` | `(this: LlmRuntime, options: GenerateOptions, next: () => AsyncIterable<StreamChunk>)` | Yielding your own chunks short-circuits the call. `options` is deep-frozen for loop-built requests. |
| `agent/request` | `(this: Scoped<Agent>, payload: {agent, turn, step, signal}, next: () => Promise<LlmCallConfig>)` | Runs after assembly and `step/start`, before the system prompt and user batch are committed. Cannot mutate messages. |
| `system-prompt/assemble` | `(this: Scoped<SystemPrompt>, assembly, context, next: () => Promise<PromptAssembly>)` | The returned value is authoritative, except that a `complete` section is restored afterwards. |
| `tools/pre-execute` | `(this: Scoped<ToolRuntime>, exec: ToolExecution, next: () => Promise<PreToolDecision>)` | `PreToolDecision` is `allow` / `deny` / `cancel` / `ask`. |

**Scope-filtered dispatch.** The `Scoped<…>` events are emitted with a scope target and reach
the emitting context and its ancestors — see
[architecture.md](architecture.md#events-reach-ancestors-not-siblings). Register them on
`ctx.root`.

**Client→Host is not covered.** `host.call` is documented for *dynamic* packages
(`dsh-cordis-host-runner`), and an installed bundle cannot rely on it. Anything the client half
needs has to come from a `webServer` route.

## Selected types

```ts
GenerateOptions {
  provider: string; model: string; reasoningEffort?: ReasoningEffortId
  messages: RequestMessage[]; system?: string; tools?: ToolSchema[]; toolHistory?: ToolHistory
  temperature?: number; maxTokens?: number; stop?: string[]
  signal?: AbortSignal; sessionId?: Branded<'SessionId'>
  purpose?: 'compaction' | 'session-title'      // must be left alone
}

StreamChunk =
  | { type: 'block-start'; index: number; blockType: ContentBlockType }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; id: ToolCallId; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason; replayState?: ReplayEnvelope }

LlmCallConfig { provider: string; model: string; reasoningEffort?: ReasoningEffortId
                temperature?: number; maxTokens?: number; stop?: string[] }
```

`maxTokens` being `undefined` means "the adapter's default"; `LlmCallConfigAdapterDefaults`
reports `{ maxTokens: true }` when the machine filled it in. That flag is what makes a clamp
observable in a session log — a clamped request logs a number with no such flag.

## Behaviours verified in DSH's own sources

| Claim | Where |
|---|---|
| A prepared call still goes through `llm/stream` | `LlmRuntime.prepareCall()` returns `stream: (options) => this.streamWithRegistration(…)`, and `streamWithRegistration` calls `ctx.waterfall(this, 'llm/stream', …)` |
| `usage` and `finish` are both optional on a stream | `BlockAssembler`: `get usage()` returns `undefined` until one arrives; `get finish()` returns `_finish ?? { kind: 'stop' }` |
| A settlement without `usage` makes token metering read `data.stream` | `dsh-token-meter`'s `usageOf()`, and `lastAssistantStreamChunk()` which dereferences `stream.length` |
| The agent loop writes the `assistant/message` | `agent-loop` appends `{ turn, step, message, ...usage, stream }` itself |
| `sessionId` is present on loop-built requests | `buildRequest()` sets `sessionId: this.session.id` |
| Empty prompt sections are dropped | `dsh-system-prompt` filters `section.text.length > 0` |
| A session header records `origin: 'subagent'` | the first frame of a subagent session log |

## Plugin package format

The shape this plugin uses; `dsh-terminal-theme` and `dsh-whale-widget` are working examples of
the same conventions.

```jsonc
{
  "type": "module",
  "icon": "./icon.svg",
  "exports": { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },   // one path, or an ordered list of layers
    "client": { "platform": "web", "immediately": true }
  }
}
```

`cordis.patch.yml` inserts the entry:

```yaml
- insert:
    - id: ai-curfew
      name: dsh-ai-curfew
```

- The Host half is plain Node ESM. It may import `node:*` built-ins freely.
- The Client half is hand-written, needs no build step, and must not use bare imports other
  than `react`. Only the baseline React hooks are safe — `useSyncExternalStore` is not part of
  it, and a missing export takes the page down.
- A plugin that registers a `webServer` route must ask `connection.requestRejection(request)`
  first, and treat a fence that throws as a denial.
- Registrations should return their disposer, wrapped in `ctx.effect` so the fiber owns them.
- Services are optional unless declared in `inject`; resolve them with `ctx.get(name)` behind an
  `undefined` check so a missing one cannot strand the fiber.

`dsh.manifestVersion` and `engines.dsh` are optional and are not enforced by the current
installer.

## Installing a local build

```sh
dsh plugin --profile <profile> add link:/absolute/path/to/ai-curfew
```

Plugin Manager applies this live, without a restart. Editing the source afterwards does **not**
take effect until the process restarts — see
[architecture.md](architecture.md#developing-against-a-running-host) and `scripts/dev-reload.ps1`.
