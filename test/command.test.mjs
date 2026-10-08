/**
 * The `/curfew` subcommands.
 *
 * The handler is a pure function of the configuration, the file overlay, and the
 * in-memory overrides the previous commands left behind, so every branch is
 * reachable here. What this cannot cover is DSH's own plumbing from the composer
 * to the handler, which is why the acceptance record still lists the command as
 * verified-by-inspection only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from '../config.js';
import { curfewCommand, parseDuration } from '../index.js';

// Pin the clock so the assertions do not depend on when the suite runs.
const readConfig = () => ({ ...structuredClone(DEFAULTS), debugNow: '01:30' });
const command = curfewCommand(readConfig);
const run = (rawInput) => command.handler({ rawInput });

test('the command advertises itself and its arguments', () => {
  assert.equal(command.name, 'curfew');
  assert.equal(typeof command.description, 'string');
  assert.ok(command.input.hint.includes('status'));
});

test('status reports the verdict, the budget, and where the config lives', () => {
  run('on');
  const result = run('status');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /winding/);
  assert.match(result.text, /560 tokens/, '01:30 must land on the 560 anchor');
  assert.match(result.text, /config\.json/);
});

test('a bare invocation is the same as status', () => {
  run('on');
  assert.equal(run('').text, run('status').text);
});

test('now forces the night and on hands the day back', () => {
  run('on');
  assert.equal(run('now').kind, 'success');
  assert.match(run('status').text, /lights-out/);

  assert.equal(run('on').kind, 'success');
  assert.match(run('status').text, /winding/, 'the overrides are gone, so the config clock is back');
});

test('off snoozes, and a snoozed plugin says so instead of reporting the schedule', () => {
  run('on');
  const result = run('off 30m');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /30 分钟/);

  const status = run('status');
  assert.match(status.text, /已停用/, 'the effective verdict is "not acting", not the schedule');
  assert.match(status.text, /小睡中/);
  assert.match(status.text, /若不停用\s+winding/, 'the schedule verdict is still reported, as context');
});

test('off defaults to half an hour and rejects nonsense', () => {
  run('on');
  assert.match(run('off').text, /30 分钟/);

  run('on');
  assert.equal(run('off nonsense').kind, 'error');
  assert.equal(run('off 0').kind, 'error', 'a zero-length snooze is a mistake, not a request');
});

test('debug moves the clock and clear puts it back', () => {
  run('on');
  const moved = run('debug 03:10');
  assert.equal(moved.kind, 'success');
  assert.match(run('status').text, /lights-out/);

  const cleared = run('debug clear');
  assert.equal(cleared.kind, 'success');
  assert.match(run('status').text, /winding/, 'back to the configured 01:30');
});

test('debug refuses a moment it cannot parse', () => {
  run('on');
  assert.equal(run('debug 25:00').kind, 'error');
  assert.equal(run('debug nonsense').kind, 'error');
  assert.equal(run('debug').kind, 'error');
});

test('debug survives a full timestamp', () => {
  run('on');
  const result = run('debug 2026-10-01 10:00');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /2026-10-01 10:00/, 'the status block echoes the pinned moment');
});

test('an unknown subcommand lists what is available', () => {
  const result = run('nap');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /status/);
  assert.match(result.text, /debug/);
});

test('duration parsing is shared with the shipped defaults', () => {
  assert.equal(parseDuration('30m'), 30 * 60000);
});
