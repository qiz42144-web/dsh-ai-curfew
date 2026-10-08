/**
 * Wall-clock reads in the configured timezone, plus the time machine.
 *
 * Everything here is pure apart from `Intl` formatting, and nothing imports a
 * sibling module, so `node --test` can exercise it directly.
 */

const FORMATTERS = new Map();

function formatterFor(timeZone) {
  let formatter = FORMATTERS.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23', // h23, not hour12:false: some ICU builds report midnight as 24
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    FORMATTERS.set(timeZone, formatter);
  }
  return formatter;
}

const pad2 = (value) => String(value).padStart(2, '0');

/**
 * Break one instant into local calendar fields for a timezone.
 *
 * @param date - the instant to read.
 * @param timeZone - IANA zone name.
 * @returns local fields, including `minutes` (minutes past local midnight).
 */
export function localFields(date, timeZone) {
  const parts = formatterFor(timeZone).formatToParts(date);
  const field = (type) => {
    const hit = parts.find((part) => part.type === type);
    return hit === undefined ? Number.NaN : Number(hit.value);
  };
  const year = field('year');
  const month = field('month');
  const day = field('day');
  const hour = field('hour');
  const minute = field('minute');
  return {
    year,
    month,
    day,
    hour,
    minute,
    // Derive the weekday from the calendar date instead of the locale's
    // weekday name, which would tie this module to one ICU locale.
    dow: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
    minutes: hour * 60 + minute,
  };
}

const CLOCK = /^(\d{1,2}):(\d{2})$/;
const MOMENT = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?$/;

/**
 * Parse a debug moment.
 *
 * @param spec - `HH:MM` (today's date) or `YYYY-MM-DD[ HH:MM]`.
 * @param today - the local fields supplying the date or the time to borrow.
 * @returns parsed local fields, or `null` when `spec` is malformed.
 */
export function parseMoment(spec, today) {
  const clock = CLOCK.exec(spec);
  if (clock !== null) {
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour > 23 || minute > 59) return null;
    return { ...today, hour, minute, minutes: hour * 60 + minute };
  }

  const moment = MOMENT.exec(spec);
  if (moment === null) return null;
  const year = Number(moment[1]);
  const month = Number(moment[2]);
  const day = Number(moment[3]);
  const hour = moment[4] === undefined ? 0 : Number(moment[4]);
  const minute = moment[5] === undefined ? 0 : Number(moment[5]);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return {
    year,
    month,
    day,
    hour,
    minute,
    dow: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    dateKey: `${year}-${pad2(month)}-${pad2(day)}`,
    minutes: hour * 60 + minute,
  };
}

/**
 * The instant the duty decision should be made for.
 *
 * @param config - effective configuration.
 * @param realDate - the real instant; injectable so tests never depend on the clock.
 * @returns local fields plus `debug`, true when `config.debugNow` supplied them.
 */
export function resolveNow(config, realDate = new Date()) {
  const real = localFields(realDate, config.timezone);
  const debug = typeof config.debugNow === 'string' ? config.debugNow.trim() : '';
  if (debug === '') return { ...real, debug: false };
  const parsed = parseMoment(debug, real);
  if (parsed === null) return { ...real, debug: false };
  return { ...parsed, debug: true };
}

/** Minutes past midnight for an `HH:MM` string, or `null` when malformed. */
export function timeOfDay(spec) {
  if (typeof spec !== 'string') return null;
  const match = CLOCK.exec(spec.trim());
  if (match === null) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) return null;
  return hour * 60 + minute;
}

/** Positive modulo — the whole duty window is expressed modulo one day. */
export function mod(value, base) {
  return ((value % base) + base) % base;
}

/** True when `minute` falls in the forward window `[start, end)` that may wrap midnight. */
export function withinWindow(minute, start, end) {
  const length = mod(end - start, 1440);
  if (length === 0) return false;
  return mod(minute - start, 1440) < length;
}
