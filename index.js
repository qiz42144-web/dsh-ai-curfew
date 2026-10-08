/**
 * Host half of dsh-ai-curfew: two gates on the model call path.
 *
 * The off-duty reply is produced by short-circuiting the `llm/stream` waterfall
 * with a synthetic chunk stream. Nothing is sent to the provider, so an
 * off-duty turn costs zero tokens and returns in milliseconds — while the agent
 * loop still assembles and appends a real assistant message, which is why the
 * message lands in the session log instead of the turn simply vanishing.
 *
 * The stream is deliberately *not* hand-written into the session: `agent/pre-step`
 * rejection plus a hand-built event once shipped a bad `assistant/message` and
 * permanently broke the affected sessions' history. Here DSH itself writes the
 * event, so every required field is present by construction.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { createConfigReader, dshHome } from './config.js';
import { resolveNow } from './clock.js';
import { LIGHTS_OUT, OFF_DUTY, resolveDuty } from './duty.js';

export const name = 'ai-curfew';

/** No hard dependencies: every service is optional here, so a missing one cannot strand the fiber. */
export const inject = [];

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
  markLoaded();

  ctx.effect(() =>
    ctx.on('llm/stream', (options, next) => {
      const decision = decide(readConfig(), options);
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

  note('[ai-curfew] host half loaded');
}
