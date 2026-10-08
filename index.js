/**
 * Host half of dsh-ai-curfew: five gates on the model call path.
 *
 *   1. `llm/stream`      — off duty means no request at all, just a canned reply
 *   2. `agent/request`   — the shrinking max_tokens budget
 *   3. `systemPrompt`    — the tired persona that makes short look intentional
 *   4. `tools/pre-execute` — no new work once the AI is off the clock
 *   5. `/curfew`         — the control surface
 *
 * The off-duty reply short-circuits the `llm/stream` waterfall with a synthetic
 * chunk stream. Nothing is sent to the provider, so the turn costs zero tokens
 * and returns in milliseconds — while the agent loop still assembles and appends
 * a real assistant message, which is why the message lands in the session log
 * instead of the turn simply vanishing.
 *
 * That stream is deliberately *not* hand-written into the session: `agent/pre-step`
 * rejection plus a hand-built event once shipped a bad `assistant/message` and
 * permanently broke the affected sessions' history. Here DSH itself writes the
 * event, so every required field is present by construction.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { configPath, createConfigReader, dshHome } from './config.js';
import { resolveNow, timeOfDay } from './clock.js';
import { LIGHTS_OUT, OFF_DUTY, WINDING, clampMaxTokens, personaFor, resolveDuty } from './duty.js';

export const name = 'ai-curfew';

/** No hard dependencies: every service is optional here, so a missing one cannot strand the fiber. */
export const inject = [];

const pad2 = (value) => String(value).padStart(2, '0');

/**
 * The name of the prompt section this plugin appends during the curfew. It is
 * appended to the assembled sections, so it lands after every shipped section
 * and reads as the freshest behavioural note in the prompt.
 */
const SECTION_NAME = 'ai-curfew:curfew';

/**
 * In-memory overrides owned by `/curfew`. They layer over the configuration file
 * rather than editing it, so a temporary shift never becomes a permanent one.
 */
const overrides = {
  overtimeUntilMs: 0,
  debugNow: null,
  forceOff: false,
};

/**
 * The synthetic stream that stands in for a provider response.
 *
 * Shape matters. `BlockAssembler` tolerates delta-only protocols and defaults a
 * missing `finish` to `{kind:'stop'}`, so the minimum would be one `text-delta`.
 * We emit the explicit four-chunk form anyway, and we do send `usage` with
 * zeros: `dsh-token-meter` reads a settlement's `usage`, and only when that is
 * absent does it fall back to scanning `event.data.stream`.
 *
 * @param text - the canned reply.
 * @returns an async iterable of stream chunks.
 */
export function syntheticStream(text) {
  return (async function* generate() {
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

/**
 * Does this agent object look like a delegated subagent?
 *
 * The scoped hooks only ever see a session id, so the classification has to
 * happen where the whole agent is in hand — `agent/request` runs earlier in the
 * same step and carries it. The shape inspected here is not part of the
 * documented contract, so every access is guarded: a miss simply means "treat it
 * as a root agent", which is what the default configuration does anyway.
 */
export function looksLikeSubagent(agent) {
  try {
    const header = agent?.session?.header;
    if (header === null || typeof header !== 'object') return false;
    if (header.parentSession !== undefined && header.parentSession !== null) return true;
    return header.origin === 'subagent';
  } catch {
    return false;
  }
}

/** Should this session be left alone because delegated work is exempt? */
export function sparesSubagent(config, isSubagent) {
  return config?.applyToSubagents === false && isSubagent === true;
}

/**
 * Should this call be answered without a request?
 *
 * Returns `null` for every call the plugin has no opinion about. When it does
 * have an opinion it reports it even for exempt sessions and dry runs, so the
 * journal can answer "why did nothing happen?".
 *
 * @param config - effective configuration.
 * @param options - the `GenerateOptions` of the call being made.
 * @returns `{reply, duty, sessionId, exempt, dryRun}` or `null`.
 */
export function decide(config, options) {
  if (config.enabled === false) return null;

  // Compaction and session-title calls carry a purpose; short-circuiting those
  // would break automatic titles and context compaction rather than the chat.
  if (options?.purpose !== undefined) return null;

  const now = resolveNow(config);
  const duty = resolveDuty(now, config);
  if (duty.state !== OFF_DUTY && duty.state !== LIGHTS_OUT) return null;

  const sessionId = typeof options?.sessionId === 'string' ? options.sessionId : null;
  const exemptSessions = Array.isArray(config.exemptSessions) ? config.exemptSessions : [];
  return {
    reply: duty.reply ?? '',
    duty,
    now,
    sessionId,
    exempt: sessionId !== null && exemptSessions.includes(sessionId),
    dryRun: config.dryRun === true,
  };
}

/** Where the last decision is recorded, for `/curfew status` and for tests. */
export function journalPath() {
  return join(dshHome(), 'dsh-ai-curfew', 'last-decision.json');
}

/** Where the running host half stamps itself, so `/curfew status` can name the loaded build. */
export function loadedPath() {
  return join(dshHome(), 'dsh-ai-curfew', 'loaded.json');
}

/** Where the prompt-injection path reports itself, so `/curfew status` can prove it reached a prompt. */
export function promptProbePath() {
  return join(dshHome(), 'dsh-ai-curfew', 'prompt-probe.json');
}

/**
 * Record that the persona hook ran and what it injected.
 *
 * Only during a dry run: this is a diagnostic for answering "is the persona
 * reaching an agent's prompt at all?", and a file write on every assembly is not
 * a price worth paying the rest of the time.
 */
function promptProbe(entry, config) {
  if (config?.dryRun !== true) return;
  try {
    const file = promptProbePath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), ...entry }, null, 2)}\n`);
  } catch {
    /* a diagnostic must never break prompt assembly */
  }
}

function markLoaded() {
  const file = loadedPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid }, null, 2)}\n`);
  } catch {
    /* a diagnostic marker must never stop the plugin from loading */
  }
}

function record(decision, action) {
  const file = journalPath();
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(
      file,
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          action,
          state: decision.duty.name,
          reply: decision.reply,
          maxTokens: decision.duty.maxTokens,
          reason: decision.duty.reason,
          sessionId: decision.sessionId,
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    /* the journal is a convenience; it must never break a model call */
  }
}

/** Minutes past midnight to `HH:MM`, wrapping at either end of the day. */
function clockText(minutes) {
  const wrapped = ((Math.trunc(minutes) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(wrapped / 60))}:${pad2(wrapped % 60)}`;
}

/**
 * Parse an overtime shift: `45`, `30m`, `2h`, `90s`.
 *
 * @param spec - the user's text.
 * @returns milliseconds, or `null` when unparseable.
 */
export function parseDuration(spec) {
  const match = /^(\d+)\s*([smh]?)$/i.exec(String(spec ?? '').trim());
  if (match === null) return null;
  const value = Number(match[1]);
  const unit = (match[2] || 'm').toLowerCase();
  return value * (unit === 's' ? 1000 : unit === 'h' ? 3600000 : 60000);
}

function overtimeLeftMs() {
  return Math.max(0, overrides.overtimeUntilMs - Date.now());
}

/**
 * The configuration every gate reads: the file, plus whatever `/curfew` has
 * overridden in memory.
 *
 * Both overrides are expressed through paths the rest of the plugin already
 * understands — an overtime shift is a temporary disable, and forcing the night is done
 * by moving the clock past lights-out — so there is no second decision path to
 * keep in sync with the tested one.
 */
function layer(readConfig) {
  let config = readConfig();
  if (overrides.debugNow !== null) config = { ...config, debugNow: overrides.debugNow };
  if (overrides.forceOff) {
    const lightsOut = timeOfDay(config.lightsOut) ?? 180;
    config = { ...config, debugNow: clockText(lightsOut + 10) };
  }
  if (Date.now() < overrides.overtimeUntilMs) config = { ...config, enabled: false };
  return config;
}

function statusText(readConfig) {
  const stored = readConfig();
  const config = layer(() => stored);
  const now = resolveNow(config);
  const duty = resolveDuty(now, config);
  const budget =
    duty.maxTokens !== null
      ? `${duty.maxTokens} tokens`
      : duty.reply !== null
        ? '不发送请求'
        : '不干预';

  // An overtime shift and `enabled: false` both arrive here as a disabled config, and in
  // both cases the schedule is no longer what will actually happen. Reporting
  // the verdict anyway would be a lie about the only thing this command is for.
  const acting = config.enabled !== false;
  const overtimeMs = overtimeLeftMs();

  const verdict = acting
    ? duty.name
    : overtimeMs > 0
      ? `加班中（宵禁暂停，还剩 ${Math.ceil(overtimeMs / 60000)} 分钟）`
      : '已停用（配置 enabled: false）';

  return [
    'AI 熄灯 · 当前班表',
    `  判定       ${verdict}`,
    `  依据       ${duty.reason}`,
    acting ? `  预算       ${budget}` : `  班表本应   ${duty.name} · ${budget}`,
    duty.reply === null ? null : `  回法       ${JSON.stringify(duty.reply)}`,
    `  峰值闸门   ${config.peakShift === false ? '关' : '开'}`,
    `  时间来源   ${overrides.debugNow !== null ? `运行时 ${overrides.debugNow}` : stored.debugNow ? `配置 ${stored.debugNow}` : '真实时间'}`,
    overrides.forceOff ? '  覆盖       强制下班（/curfew auto 取消）' : null,
    `  配置文件   ${configPath()}`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

/** The client-facing status route. */
const STATUS_ROUTE = '/ai-curfew/state.json';

/**
 * Ask the Host's trust fence whether this request may be served at all.
 *
 * @param connection - the `connection` service, when the Host mounts one.
 * @param request - the incoming request.
 * @returns an HTTP status to answer with, or `0` to serve the request.
 */
function trustDenial(connection, request) {
  if (connection === undefined || connection === null) return 0;
  if (typeof connection.requestRejection !== 'function') return 0;
  try {
    const code = connection.requestRejection(request);
    if (code === undefined || code === null || code === false || code === 0) return 0;
    return typeof code === 'number' ? code : 403;
  } catch {
    // A fence that throws must not be read as approval.
    return 403;
  }
}

/**
 * The payload the status capsule polls.
 *
 * Deliberately small, and made only of what is already visible in the
 * conversation: what the AI is doing, never what was asked of it.
 */
function statePayload(readConfig) {
  const stored = readConfig();
  const config = layer(() => stored);
  const now = resolveNow(config);
  const duty = resolveDuty(now, config);
  // An overtime shift and `enabled: false` both arrive here as a disabled config. The
  // capsule must show what will actually happen, not what the schedule would
  // have said, so `state` is the effective one and `scheduleState` keeps the
  // schedule's own verdict for the settings page.
  const acting = config.enabled !== false;
  return {
    at: Date.now(),
    enabled: acting,
    state: acting ? duty.name : 'on-duty',
    scheduleState: duty.name,
    reply: acting ? duty.reply : null,
    maxTokens: acting ? duty.maxTokens : null,
    progress: duty.progress,
    peak: duty.peak,
    reason: duty.reason,
    debug: now.debug,
    overtimeMs: overtimeLeftMs(),
    forced: overrides.forceOff,
    schedule: {
      wakeUp: config.wakeUp,
      curfewStart: config.curfewStart,
      lightsOut: config.lightsOut,
      peakShift: config.peakShift !== false,
      peakWindows: config.peakWindows,
    },
  };
}

const ok = (text) => ({ kind: 'success', text });
const err = (text) => ({ kind: 'error', text });

/**
 * `/curfew` — the only way to see the current verdict and to override it without
 * editing a file. Commands never reach the model, which is what makes this the
 * escape hatch when the AI has already locked itself out.
 *
 * Exported so the subcommands can be exercised without a UI.
 */
export function curfewCommand(readConfig) {
  return {
    name: 'curfew',
    description: '查看或临时调整 AI 熄灯班表',
    input: { hint: '[status | overtime <时长> | off | auto | debug <HH:MM> | debug clear]' },
    handler: (invocation) => {
      const raw = String(invocation?.rawInput ?? '').trim();
      const [verb = 'status', ...rest] = raw.split(/\s+/).filter(Boolean);

      switch (verb.toLowerCase()) {
        case 'status':
          return ok(statusText(readConfig));

        case 'auto':
          overrides.overtimeUntilMs = 0;
          overrides.forceOff = false;
          overrides.debugNow = null;
          return ok(`已恢复自动班表，手动覆盖全部取消。\n\n${statusText(readConfig)}`);

        case 'off':
          if (rest.length > 0) {
            return err('`off` 不接参数。要让它加班，用 /curfew overtime 30m。');
          }
          overrides.forceOff = true;
          overrides.overtimeUntilMs = 0;
          return ok(`已强制下班，回复会变成 ${JSON.stringify(readConfig().lightsOutReply)}。用 /curfew auto 恢复班表。`);

        case 'overtime': {
          const ms = parseDuration(rest[0] ?? '30m');
          if (ms === null || ms <= 0) return err('时长写法不对，例如 /curfew overtime 30m、/curfew overtime 2h。');
          overrides.forceOff = false;
          overrides.overtimeUntilMs = Date.now() + ms;
          return ok(`已强制加班 ${Math.round(ms / 60000)} 分钟，期间正常上班。用 /curfew auto 让它收工。`);
        }

        case 'debug': {
          const spec = rest.join(' ').trim();
          if (spec === '') return err('用法：/curfew debug 01:30，或 /curfew debug clear。');
          if (spec.toLowerCase() === 'clear') {
            overrides.debugNow = null;
            return ok(`已回到真实时间。\n\n${statusText(readConfig)}`);
          }
          if (resolveNow({ ...readConfig(), debugNow: spec }).debug === false) {
            return err(`解析不了「${spec}」，用 HH:MM 或 YYYY-MM-DD HH:MM。`);
          }
          overrides.debugNow = spec;
          overrides.forceOff = false;
          return ok(`时间机器已设为 ${spec}。\n\n${statusText(readConfig)}`);
        }

        default:
          return err(`未知子命令「${verb}」。可用：status / overtime <时长> / off / auto / debug <HH:MM> / debug clear。`);
      }
    },
  };
}

export function apply(ctx) {
  const sink = ctx.logger ?? console;
  const note = (message) => {
    try {
      sink.info?.(message);
    } catch {
      /* logging must never break a model call */
    }
  };
  const warn = (message) => {
    try {
      sink.warn?.(message);
    } catch {
      /* ditto */
    }
  };

  const readConfig = createConfigReader(warn);
  const currentConfig = () => layer(readConfig);

  /**
   * Session ids observed to be delegated subagents.
   *
   * `agent/request` runs earlier in the same step and carries the whole agent,
   * so it is where the classification is learned; `llm/stream` and
   * `tools/pre-execute` only ever see a session id and consult this set.
   */
  const subagentSessions = new Set();
  const isSubagent = (sessionId) => typeof sessionId === 'string' && subagentSessions.has(sessionId);

  markLoaded();

  // Cordis dispatches an event to the emitting context and its ancestors, so a
  // listener on this plugin's own context only sees events emitted at or above
  // the root. `llm/stream` happens to be one of those, but `agent/request` and
  // `tools/pre-execute` are emitted from the agent's own scope — a sibling
  // branch — and would never arrive here. Root registration is what makes the
  // agent-scoped hooks reachable; the effect still disposes them with the fiber.
  const events = ctx.root ?? ctx;

  // 1. Off duty: answer without sending anything.
  ctx.effect(() =>
    events.on('llm/stream', (options, next) => {
      const config = currentConfig();
      if (sparesSubagent(config, isSubagent(options?.sessionId))) return next();

      const decision = decide(config, options);
      if (decision === null) return next();

      if (decision.exempt) {
        record(decision, 'exempt');
        return next();
      }
      if (decision.dryRun) {
        record(decision, 'dry-run');
        return next();
      }

      record(decision, 'short-circuit');
      note(`[ai-curfew] ${decision.duty.name} · ${decision.duty.reason} — no request sent, replying ${JSON.stringify(decision.reply)}`);
      return syntheticStream(decision.reply);
    }),
  );

  // 2. The shrinking budget. `agent/request` is the only place a max_tokens cap
  // can be applied: `llm/stream` receives a deep-frozen request and must not
  // rewrite it. The waterfall hands us the config the machine would use, and we
  // return a replacement — never a raise, only a cap.
  ctx.effect(() =>
    events.on('agent/request', async (payload, next) => {
      const base = await next();
      const config = currentConfig();
      if (config.enabled === false) return base;

      // The one place the whole agent is in hand, so the one place a delegated
      // session can be recognised for the two hooks that only see an id.
      if (looksLikeSubagent(payload?.agent)) {
        const id = payload?.agent?.id;
        if (typeof id === 'string') subagentSessions.add(id);
      }

      const sessionId = payload?.agent?.id;
      if (typeof sessionId === 'string') {
        const exempt = Array.isArray(config.exemptSessions) ? config.exemptSessions : [];
        if (exempt.includes(sessionId)) return base;
      }
      if (sparesSubagent(config, isSubagent(sessionId))) return base;

      const duty = resolveDuty(resolveNow(config), config);
      const replacement = { ...base };

      const clamped = clampMaxTokens(base.maxTokens, duty, config);
      if (clamped !== null) replacement.maxTokens = clamped;

      const effort = config.windingReasoningEffort;
      if (duty.state === WINDING && typeof effort === 'string' && effort !== '') replacement.reasoningEffort = effort;

      if (clamped === null && replacement.reasoningEffort === base.reasoningEffort) return base;
      note(`[ai-curfew] ${duty.name} · ${duty.reason} — budget ${base.maxTokens ?? '(adapter default)'} → ${replacement.maxTokens ?? base.maxTokens}`);
      return replacement;
    }),
  );

  // 3. The tired persona.
  //
  // Injected through the `system-prompt/assemble` waterfall rather than
  // `systemPrompt.section()`. Sections are merged per scope (`assemble()` calls
  // `layers.merge(scope, …)`) and the service registers into the layer of its
  // own context, which an agent's assembly does not necessarily include. The
  // waterfall is the documented expert hook, and it is dispatched with a scope
  // target, so it is reachable from the root exactly like the two hooks above.
  //
  // Outside the curfew the assembly is returned untouched, so this costs one
  // predicate and no prompt tokens.
  ctx.effect(() =>
    events.on('system-prompt/assemble', async (assembly, _context, next) => {
      const result = await next();
      const config = currentConfig();
      const text = personaFor(resolveDuty(resolveNow(config), config), config);
      promptProbe({ hook: 'system-prompt/assemble', fired: true, text: text ?? '' }, config);
      if (text === null || text === '') return result;

      const sections = Array.isArray(result?.sections) ? result.sections : [];
      return { ...result, sections: [...sections, { name: SECTION_NAME, text }] };
    }),
  );

  // 4. No new work once the AI is off the clock — a turn that was already
  // running must not start another tool call across the boundary.
  ctx.effect(() =>
    events.on('tools/pre-execute', async (exec, next) => {
      const config = currentConfig();
      if (config.enabled === false || config.denyToolsWhenOffDuty === false) return next();

      const sessionId = exec?.agent?.id;
      if (typeof sessionId === 'string') {
        const exempt = Array.isArray(config.exemptSessions) ? config.exemptSessions : [];
        if (exempt.includes(sessionId)) return next();
      }
      if (sparesSubagent(config, isSubagent(sessionId))) return next();

      const duty = resolveDuty(resolveNow(config), config);
      if (duty.state !== OFF_DUTY && duty.state !== LIGHTS_OUT) return next();

      return { kind: 'deny', reason: `AI 熄灯（${duty.name}），不再执行工具调用。` };
    }),
  );

  // 5. The control surface.
  const commands = ctx.get('commands');
  if (commands === undefined) {
    warn('[ai-curfew] commands service is unavailable; /curfew is not registered');
  } else {
    ctx.effect(() => commands.register(curfewCommand(readConfig)));
  }

  // 6. The client capsule's data source.
  //
  // A same-origin JSON route, not an RPC: `host.call` is only documented for
  // dynamic packages, so an installed bundle cannot rely on it. Every
  // self-registered route must ask the trust fence first — it is what rejects
  // DNS-rebinding and unauthenticated requests.
  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    warn('[ai-curfew] webServer service is unavailable; the status route is not served');
  } else {
    const connection = ctx.get('connection');
    ctx.effect(() =>
      webServer.register({
        kind: 'exact',
        path: STATUS_ROUTE,
        handler: (request, response) => {
          const denial = trustDenial(connection, request);
          if (denial !== 0) {
            try {
              response.statusCode = denial;
              response.end();
            } catch {
              /* the socket may already be gone */
            }
            return;
          }
          try {
            response.writeHead(200, {
              'Content-Type': 'application/json; charset=utf-8',
              'Cache-Control': 'no-store',
            });
            response.end(JSON.stringify(statePayload(readConfig)));
          } catch (error) {
            try {
              response.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
              response.end(JSON.stringify({ error: String(error?.message ?? error) }));
            } catch {
              /* ditto */
            }
          }
        },
      }),
    );
  }

  note('[ai-curfew] host half loaded');
}
