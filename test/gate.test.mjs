/**
 * The `llm/stream` gate itself: when it acts, when it stands aside, and the
 * exact chunk sequence it hands to the agent loop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from '../config.js';
import { decide, looksLikeSubagent, sparesSubagent, syntheticStream } from '../index.js';

const config = (overrides = {}) => ({ ...structuredClone(DEFAULTS), ...overrides });

test('a delegated session is recognised from its agent record', () => {
  assert.equal(looksLikeSubagent({ id: 's', session: { header: { parentSession: 'root' } } }), true);
  assert.equal(looksLikeSubagent({ id: 's', session: { header: { origin: 'subagent' } } }), true);
  assert.equal(looksLikeSubagent({ id: 's', session: { header: { parentSession: null } } }), false);
  assert.equal(looksLikeSubagent({ id: 's', session: { header: { id: 's' } } }), false, 'a root session');
});

test('an unrecognised agent shape degrades to "root" instead of throwing', () => {
  // The shape inspected here is not part of the documented contract, so every
  // access is guarded and a miss must fall back to the default behaviour.
  assert.equal(looksLikeSubagent(undefined), false);
  assert.equal(looksLikeSubagent(null), false);
  assert.equal(looksLikeSubagent({ id: 's' }), false);
  assert.equal(looksLikeSubagent({ id: 's', session: null }), false);
  assert.equal(
    looksLikeSubagent({
      get session() {
        throw new Error('hostile getter');
      },
    }),
    false,
  );
});

test('delegated work is gated unless it is explicitly spared', () => {
  assert.equal(sparesSubagent(config(), true), false, 'the shipped default gates subagents too');
  assert.equal(sparesSubagent(config({ applyToSubagents: false }), true), true);
  assert.equal(sparesSubagent(config({ applyToSubagents: false }), false), false, 'a root session is still gated');
});

test('a lights-out moment is answered with the canned reply', () => {
  const decision = decide(config({ debugNow: '03:10' }), { sessionId: 'session-a' });
  assert.notEqual(decision, null);
  assert.equal(decision.duty.name, 'lights-out');
  assert.equal(decision.reply, '明天再说。');
  assert.equal(decision.exempt, false);
  assert.equal(decision.dryRun, false);
});

test('a peak moment is answered with the off-duty reply', () => {
  const decision = decide(config({ debugNow: '2026-09-29 10:00' }), { sessionId: 'session-a' });
  assert.equal(decision.duty.name, 'off-duty');
  assert.equal(decision.reply, '。');
});

test('an in-between moment is not our business at all', () => {
  assert.equal(decide(config({ debugNow: '20:00' }), { sessionId: 'session-a' }), null);
  assert.equal(decide(config({ debugNow: '23:30' }), { sessionId: 'session-a' }), null, 'winding still sends a real request');
});

test('compaction and title calls always pass', () => {
  assert.equal(decide(config({ debugNow: '03:10' }), { sessionId: 'session-a', purpose: 'session-title' }), null);
  assert.equal(decide(config({ debugNow: '03:10' }), { sessionId: 'session-a', purpose: 'compaction' }), null);
});

test('disabled means disabled', () => {
  assert.equal(decide(config({ enabled: false, debugNow: '03:10' }), { sessionId: 'session-a' }), null);
});

test('exempted sessions are reported but let through', () => {
  const decision = decide(config({ debugNow: '03:10', exemptSessions: ['session-dev'] }), { sessionId: 'session-dev' });
  assert.equal(decision.exempt, true, 'still reported, so the journal can explain why nothing happened');
  const other = decide(config({ debugNow: '03:10', exemptSessions: ['session-dev'] }), { sessionId: 'session-other' });
  assert.equal(other.exempt, false);
});

test('dry run reports the verdict without acting on it', () => {
  const decision = decide(config({ debugNow: '03:10', dryRun: true }), { sessionId: 'session-a' });
  assert.equal(decision.dryRun, true);
  assert.equal(decision.exempt, false);
});

test('the synthetic stream is a complete, closed sequence', async () => {
  const chunks = [];
  for await (const chunk of syntheticStream('。')) chunks.push(chunk);

  assert.deepEqual(
    chunks.map((chunk) => chunk.type),
    ['block-start', 'text-delta', 'block-end', 'usage', 'finish'],
  );
  assert.equal(chunks[0].index, 0);
  assert.equal(chunks[0].blockType, 'text');
  assert.equal(chunks[1].text, '。');
  assert.equal(chunks[2].block.text, '。');
  assert.deepEqual(chunks[3].usage, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  assert.equal(chunks[4].reason.kind, 'stop', 'a stop is what makes the loop commit an assistant message');
});
