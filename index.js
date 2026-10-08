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
 * Where the tired-persona section sits in the system prompt.
 *
 * The deployment persona suffix is 10200, so this lands immediately after the
 * persona and well past every tool instruction — late enough to be the freshest
 * behavioural note in the prompt, and no shipped section claims the slot.
 */
const SECTION_NAME = 'ai-curfew:curfew';
const SECTION_ORDER = 10250;

/**
 * In-memory overrides owned by `/curfew`. They layer over the configuration file
 * rather than editing it, so a temporary snooze never becomes a permanent one.
 */
const overrides = {
  snoozeUntilMs: 0,
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
 * Parse a snooze duration: `45`, `30m`, `2h`, `90s`.
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

function snoozeLeftMs() {
  return Math.max(0, overrides.snoozeUntilMs - Date.now());
}

/**
 * The configuration every gate reads: the file, plus whatever `/curfew` has
 * overridden in memory.
 *
 * Both overrides are expressed through paths the rest of the plugin already
 * understands — a snooze is a temporary disable, and forcing the night is done
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
  if (Date.now() < overrides.snoozeUntilMs) config = { ...config, enabled: false };
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

  return [
    'AI 熄灯 · 当前班表',
    `  判定       ${duty.name}`,
    `  依据       ${duty.reason}`,
    `  预算       ${budget}`,
    duty.reply === null ? null : `  回法       ${JSON.stringify(duty.reply)}`,
    `  峰值闸门   ${config.peakShift === false ? '关' : '开'}`,
    `  时间来源   ${overrides.debugNow !== null ? `运行时 ${overrides.debugNow}` : stored.debugNow ? `配置 ${stored.debugNow}` : '真实时间'}`,
    overrides.forceOff ? '  覆盖       强制下班（/curfew on 取消）' : null,
    snoozeLeftMs() > 0 ? `  覆盖       小睡中，还剩 ${Math.ceil(snoozeLeftMs() / 60000)} 分钟` : null,
    `  配置文件   ${configPath()}`,
  ]
    .filter((line) => line !== null)
    .join('\n');
}

const ok = (text) => ({ kind: 'success', text });
const err = (text) => ({ kind: 'error', text });

/**
 * `/curfew` — the only way to see the current verdict and to override it without
 * editing a file. Commands never reach the model.
 */
function curfewCommand(readConfig) {
  return {
    name: 'curfew',
    description: '查看或临时调整 AI 熄灯班表',
    input: { hint: '[status | on | off <时长> | now | debug <HH:MM> | debug clear]' },
    handler: (invocation) => {
      const raw = String(invocation?.rawInput ?? '').trim();
      const [verb = 'status', ...rest] = raw.split(/\s+/).filter(Boolean);

      switch (verb.toLowerCase()) {
        case 'status':
          return ok(statusText(readConfig));

        case 'on':
          overrides.snoozeUntilMs = 0;
          overrides.forceOff = false;
          return ok(`已恢复出勤。\n\n${statusText(readConfig)}`);

        case 'now':
          overrides.forceOff = true;
          overrides.snoozeUntilMs = 0;
          return ok(`已强制下班，回复会变成 ${JSON.stringify(readConfig().lightsOutReply)}。用 /curfew on 取消。`);

        case 'off': {
          const ms = parseDuration(rest[0] ?? '30m');
          if (ms === null || ms <= 0) return err('时长写法不对，例如 /curfew off 30m、/curfew off 2h。');
          overrides.forceOff = false;
          overrides.snoozeUntilMs = Date.now() + ms;
          return ok(`已请假 ${Math.round(ms / 60000)} 分钟，期间正常上班。用 /curfew on 提前销假。`);
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
          return err(`未知子命令「${verb}」。可用：status / on / off <时长> / now / debug <HH:MM> / debug clear。`);
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
  const verdict = () => resolveDuty(resolveNow(currentConfig()), currentConfig());
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
      const decision = decide(currentConfig(), options);
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

      const sessionId = payload?.agent?.id;
      if (typeof sessionId === 'string') {
        const exempt = Array.isArray(config.exemptSessions) ? config.exemptSessions : [];
        if (exempt.includes(sessionId)) return base;
      }

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

  // 3. The tired persona. An empty string is dropped by the assembler, so the
  // section costs nothing outside the curfew.
  const systemPrompt = ctx.get('systemPrompt');
  if (systemPrompt === undefined) {
    warn('[ai-curfew] systemPrompt service is unavailable; the tired persona is disabled');
  } else {
    ctx.effect(() =>
      systemPrompt.section({
        name: SECTION_NAME,
        order: SECTION_ORDER,
        text: () => {
          const config = currentConfig();
          return personaFor(resolveDuty(resolveNow(config), config), config) ?? '';
        },
      }),
    );
  }

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

  note('[ai-curfew] host half loaded');
}
