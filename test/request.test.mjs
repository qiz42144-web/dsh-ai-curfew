/**
 * The shrinking budget: `agent/request` is the only place a max_tokens cap can
 * be applied, because `llm/stream` receives a deep-frozen request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from '../config.js';
import { resolveNow } from '../clock.js';
import { OFF_DUTY, ON_DUTY, WINDING, clampMaxTokens, personaFor, resolveDuty } from '../duty.js';
import { parseDuration } from '../index.js';

const config = (overrides = {}) => ({ ...structuredClone(DEFAULTS), ...overrides });

const dutyAt = (debugNow, overrides = {}) => {
  const conf = config({ debugNow, ...overrides });
  return { conf, duty: resolveDuty(resolveNow(conf), conf) };
};

test('the budget is capped during the curfew, never raised', () => {
  const { conf, duty } = dutyAt('01:30');
  assert.equal(duty.state, WINDING);
  assert.equal(duty.maxTokens, 560);
  assert.equal(clampMaxTokens(undefined, duty, conf), 560, 'an adapter default must be capped explicitly');
  assert.equal(clampMaxTokens(4096, duty, conf), 560);
  assert.equal(clampMaxTokens(128, duty, conf), 128, 'a smaller budget the machine already chose is never raised');
});

test('the cap tracks the curve through the night', () => {
  const budget = (debugNow) => {
    const { conf, duty } = dutyAt(debugNow);
    return clampMaxTokens(undefined, duty, conf);
  };
  assert.equal(budget('23:00'), 2048);
  assert.equal(budget('00:00'), 1600);
  assert.equal(budget('01:30'), 560);
  assert.equal(budget('02:30'), 192);
  assert.equal(budget('02:59'), 68);
});

test('the safety cap applies only when it is configured', () => {
  // Off by default: the stream gate is the mechanism, and a mis-sized cap on a
  // reasoning model fails the turn outright instead of shortening it.
  const off = dutyAt('03:10');
  assert.equal(off.conf.safetyMaxTokens, null, 'the shipped default must stay off');
  assert.equal(clampMaxTokens(undefined, off.duty, off.conf), null);
  assert.equal(clampMaxTokens(4096, off.duty, off.conf), null);

  const on = dutyAt('03:10', { safetyMaxTokens: 512 });
  assert.equal(clampMaxTokens(undefined, on.duty, on.conf), 512);
  assert.equal(clampMaxTokens(8, on.duty, on.conf), 8, 'the safety cap is still a cap, not a floor');

  const peak = dutyAt('2026-09-29 10:00', { safetyMaxTokens: 512 });
  assert.equal(clampMaxTokens(4096, peak.duty, peak.conf), 512);
});

test('a dry run never changes what the machine would send', () => {
  const curfew = dutyAt('01:30', { dryRun: true });
  assert.equal(curfew.duty.maxTokens, 560, 'the verdict is still reported');
  assert.equal(clampMaxTokens(undefined, curfew.duty, curfew.conf), null, 'but nothing is applied');

  const dark = dutyAt('03:10', { dryRun: true, safetyMaxTokens: 512 });
  assert.equal(clampMaxTokens(undefined, dark.duty, dark.conf), null);
});

test('on duty is left completely alone', () => {
  const { conf, duty } = dutyAt('20:00');
  assert.equal(duty.state, ON_DUTY);
  assert.equal(clampMaxTokens(undefined, duty, conf), null, 'null means "do not touch this call"');
  assert.equal(clampMaxTokens(4096, duty, conf), null);
});

test('a nonsensical safety cap is ignored rather than applied', () => {
  const { conf, duty } = dutyAt('03:10', { safetyMaxTokens: null });
  assert.equal(clampMaxTokens(4096, duty, conf), null);
});

// --- tired persona ----------------------------------------------------------

test('the tired persona tightens as the curfew window closes', () => {
  const conf = config({ tierTexts: ['a', 'b', 'c', 'd'] });
  const band = (progress) => personaFor({ state: WINDING, progress }, conf);
  assert.equal(band(0), 'a');
  assert.equal(band(0.24), 'a');
  assert.equal(band(0.26), 'b', 'the second quarter starts a new band');
  assert.equal(band(0.5), 'c');
  assert.equal(band(0.99), 'd');
  assert.equal(band(1), 'd', 'progress 1 must not run off the end of the table');
});

test('the persona speaks only during the curfew', () => {
  const conf = config();
  assert.equal(personaFor({ state: ON_DUTY, progress: null }, conf), null, 'on duty the AI is simply itself');
  assert.equal(personaFor({ state: OFF_DUTY, progress: null }, conf), null, 'off duty there is no request to steer');
  assert.equal(personaFor({ state: WINDING, progress: 0 }, config({ tiredPersona: false })), null);
  assert.equal(personaFor({ state: WINDING, progress: 0 }, config({ tierTexts: [] })), null);
});

test('the shipped persona texts cover the whole window', () => {
  const conf = config();
  for (const progress of [0, 0.25, 0.5, 0.75, 1]) {
    const text = personaFor({ state: WINDING, progress }, conf);
    assert.equal(typeof text, 'string');
    assert.ok(text.length > 0);
  }
});

// --- /curfew duration parsing ----------------------------------------------

test('overtime durations accept bare minutes and unit suffixes', () => {
  const minute = 60000;
  assert.equal(parseDuration('30'), 30 * minute);
  assert.equal(parseDuration('30m'), 30 * minute);
  assert.equal(parseDuration(' 45m '), 45 * minute);
  assert.equal(parseDuration('2h'), 120 * minute);
  assert.equal(parseDuration('90s'), 90 * 1000);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration(''), null);
  assert.equal(parseDuration(undefined), null);
  assert.equal(parseDuration('-5m'), null);
});
