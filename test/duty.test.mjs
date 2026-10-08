/**
 * The behaviour table, asserted.
 *
 * `resolveDuty` takes local calendar fields rather than an instant, so these
 * cases name a weekday and a wall-clock time directly instead of depending on
 * the real calendar or the machine's clock.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULTS } from '../config.js';
import { parseMoment, resolveNow, timeOfDay, withinWindow } from '../clock.js';
import { budgetFor, isPeak, resolveDuty, WINDING, OFF_DUTY, LIGHTS_OUT, ON_DUTY } from '../duty.js';

const config = () => structuredClone(DEFAULTS);

/** Local fields for one moment, so a case reads as the table row it asserts. */
const at = (hour, minute, dow, dateKey = '2026-09-29') => ({
  year: 2026,
  month: 9,
  day: 29,
  hour,
  minute,
  minutes: hour * 60 + minute,
  dow,
  dateKey,
  debug: false,
});

const MON = 1;
const TUE = 2;
const SUN = 0;

test('duty cycle: on duty before curfew', () => {
  const duty = resolveDuty(at(22, 0, TUE), config());
  assert.equal(duty.state, ON_DUTY);
  assert.equal(duty.reply, null);
  assert.equal(duty.maxTokens, null, 'an on-duty turn must not be touched at all');
});

test('duty cycle: 20:00 valley is normal', () => {
  const duty = resolveDuty(at(20, 0, TUE), config());
  assert.equal(duty.state, ON_DUTY);
  assert.equal(duty.maxTokens, null);
});

test('curfew shrinks the budget along the anchor table', () => {
  const cases = [
    [23, 0, 2048],
    [23, 30, 1824],
    [0, 0, 1600],
    [0, 30, 1200],
    [1, 0, 800],
    [1, 30, 560],
    [2, 0, 320],
    [2, 30, 192],
    [2, 59, 68], // one minute short of the 03:00 anchor, on its way to 64
  ];
  for (const [hour, minute, expected] of cases) {
    const duty = resolveDuty(at(hour, minute, TUE), config());
    assert.equal(duty.state, WINDING, `${hour}:${minute} should be winding`);
    assert.equal(duty.maxTokens, expected, `${hour}:${minute} budget`);
    assert.equal(duty.reply, null, 'winding still sends a real request');
  }
});

test('the curve lands exactly on every anchor', () => {
  const conf = config();
  assert.equal(budgetFor(0, conf), 2048);
  assert.equal(budgetFor(0.25, conf), 1600);
  assert.equal(budgetFor(0.5, conf), 800);
  assert.equal(budgetFor(0.75, conf), 320);
  assert.equal(budgetFor(1, conf), 64);
});

test("curve: 'step' holds each anchor until the next", () => {
  const conf = { ...config(), curve: 'step' };
  assert.equal(budgetFor(0, conf), 2048);
  assert.equal(budgetFor(0.2, conf), 2048);
  assert.equal(budgetFor(0.25, conf), 1600);
  assert.equal(budgetFor(0.99, conf), 320, 'still on the 02:00 anchor one minute earlier');
  assert.equal(budgetFor(1, conf), 64);
});

test("curve: 'easeIn' holds the budget high, then plunges", () => {
  const conf = { ...config(), curve: 'easeIn' };
  assert.equal(budgetFor(0, conf), 2048);
  assert.equal(budgetFor(1, conf), 64);
  // Squaring the ratio means the budget lingers near full for the first half of
  // the window and then falls off a cliff — the opposite of the linear curve.
  assert.ok(budgetFor(0.5, conf) > budgetFor(0.5, config()), 'easeIn must sit above linear at the midpoint');
});

test('after curfew it is lights out, not merely short', () => {
  const duty = resolveDuty(at(3, 10, TUE), config());
  assert.equal(duty.state, LIGHTS_OUT);
  assert.equal(duty.reply, '明天再说。');
  assert.equal(duty.maxTokens, null);
});

test('lights out runs from 03:00 until wake-up at 09:00', () => {
  assert.equal(resolveDuty(at(3, 0, TUE), config()).state, LIGHTS_OUT);
  assert.equal(resolveDuty(at(8, 59, TUE), config()).state, LIGHTS_OUT);
  // 09:00 on a Sunday hands the AI back its day...
  assert.equal(resolveDuty(at(9, 0, SUN), config()).state, ON_DUTY);
  // ...while 09:00 on a weekday is already a peak hour, so it stays off duty.
  assert.equal(resolveDuty(at(9, 0, TUE), config()).state, OFF_DUTY);
});

test('peak hours send no request at all', () => {
  const duty = resolveDuty(at(10, 0, TUE), config());
  assert.equal(duty.state, OFF_DUTY);
  assert.equal(duty.reply, '。');
  assert.equal(duty.maxTokens, null);
});

test('peak windows are 9-12 and 14-18 on weekdays', () => {
  const conf = config();
  assert.equal(isPeak(at(9, 0, TUE), conf), true);
  assert.equal(isPeak(at(11, 59, TUE), conf), true);
  assert.equal(isPeak(at(12, 0, TUE), conf), false);
  assert.equal(isPeak(at(14, 0, TUE), conf), true);
  assert.equal(isPeak(at(18, 0, TUE), conf), false);
  assert.equal(isPeak(at(10, 0, MON), conf), true);
});

test('weekends are valley the whole day', () => {
  assert.equal(isPeak(at(10, 0, SUN), config()), false);
  assert.equal(resolveDuty(at(14, 0, SUN), config()).state, ON_DUTY);
});

test('statutory holidays are valley even on a weekday', () => {
  const conf = config();
  assert.equal(isPeak(at(10, 0, TUE, '2026-10-01'), conf), false, '国庆 must not be peak');
  assert.equal(isPeak(at(10, 0, TUE, '2026-09-29'), conf), true);
  // ...and the curfew still applies during a holiday.
  assert.equal(resolveDuty(at(3, 10, TUE, '2026-10-01'), conf).state, LIGHTS_OUT);
});

test('peak gate can be switched off, leaving a pure curfew plugin', () => {
  const conf = { ...config(), peakShift: false };
  assert.equal(resolveDuty(at(10, 0, TUE), conf).state, ON_DUTY);
});

test('the harsher gate wins: peak during curfew replies with the off-duty line', () => {
  // 10:00 peak is outside the curfew window, so use a peak window overlapping it.
  const conf = { ...config(), peakWindows: [[1, 3]] };
  const duty = resolveDuty(at(1, 30, TUE), conf);
  assert.equal(duty.state, OFF_DUTY);
  assert.equal(duty.reply, '。');
});

test('collapsing the curfew window folds the night into lights out', () => {
  // With lightsOut == curfewStart there is no winding interval at all, so the
  // lights-out window simply starts an hour earlier and still ends at wake-up.
  const conf = { ...config(), lightsOut: '23:00' };
  assert.equal(resolveDuty(at(23, 30, TUE), conf).state, LIGHTS_OUT);
  assert.equal(resolveDuty(at(22, 30, TUE), conf).state, ON_DUTY);
});

// --- clock ------------------------------------------------------------------

test('timeOfDay validates', () => {
  assert.equal(timeOfDay('00:00'), 0);
  assert.equal(timeOfDay('23:59'), 1439);
  assert.equal(timeOfDay('24:00'), null);
  assert.equal(timeOfDay('9:5'), null);
  assert.equal(timeOfDay(540), null);
});

test('withinWindow wraps midnight', () => {
  assert.equal(withinWindow(1380, 1380, 180), true, '23:00 is the start');
  assert.equal(withinWindow(30, 1380, 180), true, '00:30 is inside');
  assert.equal(withinWindow(180, 1380, 180), false, '03:00 is the exclusive end');
  assert.equal(withinWindow(600, 1380, 180), false, '10:00 is outside');
});

test('parseMoment accepts a bare clock or a full date', () => {
  const today = at(12, 0, TUE);
  assert.deepEqual(parseMoment('03:10', today).minutes, 190);
  assert.equal(parseMoment('03:10', today).dateKey, today.dateKey, 'bare HH:MM borrows today');
  const full = parseMoment('2026-10-01 10:00', today);
  assert.equal(full.dateKey, '2026-10-01');
  assert.equal(full.minutes, 600);
  assert.equal(full.dow, 4, '2026-10-01 is a Thursday');
  assert.equal(parseMoment('25:00', today), null);
  assert.equal(parseMoment('nonsense', today), null);
});

test('debugNow overrides the real clock', () => {
  const instant = new Date('2026-09-29T02:00:00Z'); // Beijing 10:00
  const conf = { ...config(), debugNow: '2026-10-01 10:00' };
  const now = resolveNow(conf, instant);
  assert.equal(now.debug, true);
  assert.equal(now.dateKey, '2026-10-01');
  assert.equal(resolveDuty(now, conf).state, ON_DUTY, 'holiday 10:00 is valley, not peak');
});

test('without debugNow the real clock is used', () => {
  const instant = new Date('2026-09-29T02:00:00Z'); // Beijing 10:00 Tuesday
  const now = resolveNow(config(), instant);
  assert.equal(now.debug, false);
  assert.equal(now.hour, 10);
  assert.equal(resolveDuty(now, config()).state, OFF_DUTY, '10:00 Tuesday is peak');
});
