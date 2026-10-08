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
  assert.ok(command.input.hint.includes('overtime'));
  assert.ok(command.input.hint.includes('auto'));
});

test('status reports the verdict, the budget, and where the config lives', () => {
  run('auto');
  const result = run('status');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /winding/);
  assert.match(result.text, /560 tokens/, '01:30 must land on the 560 anchor');
  assert.match(result.text, /config\.json/);
});

test('a bare invocation is the same as status', () => {
  run('auto');
  assert.equal(run('').text, run('status').text);
});

test('off forces the night and auto hands the day back', () => {
  run('auto');
  assert.equal(run('off').kind, 'success');
  assert.match(run('status').text, /lights-out/);

  assert.equal(run('auto').kind, 'success');
  assert.match(run('status').text, /winding/, 'the override is gone, so the config clock is back');
});

test('off refuses a duration and points at overtime', () => {
  run('auto');
  const result = run('off 30m');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /overtime/, 'the old spelling should teach the new one');
});

test('overtime reports itself as overtime instead of the schedule', () => {
  run('auto');
  const result = run('overtime 30m');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /强制加班 30 分钟/);

  const status = run('status');
  assert.match(status.text, /加班中/, 'the effective verdict is overtime, not the schedule');
  assert.match(status.text, /还剩 30 分钟/);
  assert.match(status.text, /班表本应\s+winding/, 'the schedule is kept as context');
});

test('overtime defaults to half an hour and rejects nonsense', () => {
  run('auto');
  assert.match(run('overtime').text, /30 分钟/);

  run('auto');
  assert.equal(run('overtime nonsense').kind, 'error');
  assert.equal(run('overtime 0').kind, 'error', 'a zero-length shift is a mistake, not a request');
});

test('debug moves the clock and clear puts it back', () => {
  run('auto');
  assert.equal(run('debug 03:10').kind, 'success');
  assert.match(run('status').text, /lights-out/);

  assert.equal(run('debug clear').kind, 'success');
  assert.match(run('status').text, /winding/, 'back to the configured 01:30');
});

test('auto is a full reset, time machine included', () => {
  run('auto');
  run('debug 03:10');
  assert.match(run('status').text, /lights-out/);

  run('auto');
  assert.match(run('status').text, /winding/, 'auto drops every override, so the config clock rules again');
});

test('debug refuses a moment it cannot parse', () => {
  run('auto');
  assert.equal(run('debug 25:00').kind, 'error');
  assert.equal(run('debug nonsense').kind, 'error');
  assert.equal(run('debug').kind, 'error');
});

test('debug survives a full timestamp', () => {
  run('auto');
  const result = run('debug 2026-10-01 10:00');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /2026-10-01 10:00/, 'the status block echoes the pinned moment');
});

test('an unknown subcommand lists what is available', () => {
  const result = run('nap');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /overtime/);
  assert.match(result.text, /auto/);
  assert.match(result.text, /debug/);
});

test('the retired spellings are gone', () => {
  run('auto');
  // `on` cleared the overrides and `now` forced the night; both were renamed.
  assert.equal(run('on').kind, 'error');
  assert.equal(run('now').kind, 'error');
});

test('duration parsing is shared with the shipped defaults', () => {
  assert.equal(parseDuration('30m'), 30 * 60000);
});
