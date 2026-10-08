/**
 * The duty decision: one instant plus one configuration in, one verdict out.
 *
 * Pure and dependency-free beyond its sibling `clock.js` helpers, so the whole
 * behaviour table can be asserted by `node --test` without a running Host.
 *
 * Two gates, and the harsher one wins:
 *
 *   A. peak/valley shift  — peak hours are off duty (a canned reply, no request)
 *   B. curfew curve       — replies shrink from `curfewStart` to `lightsOut`,
 *                           then nothing is sent until `wakeUp`
 */
import { mod, timeOfDay, withinWindow } from './clock.js';

/** Duty states, ordered by severity: the maximum of the two gates is the verdict. */
export const ON_DUTY = 0;
export const WINDING = 1;
export const OFF_DUTY = 2;
export const LIGHTS_OUT = 3;

export const STATE_NAME = ['on-duty', 'winding', 'off-duty', 'lights-out'];

/**
 * Is this instant inside the peak (expensive) window?
 *
 * Peak is the published DeepSeek rule: Monday–Friday 9:00–12:00 and 14:00–18:00,
 * excluding weekends and Chinese statutory holidays. See PROVENANCE.md.
 */
export function isPeak(now, config) {
  if (config.weekendValley !== false && (now.dow === 0 || now.dow === 6)) return false;
  const holidays = config.holidays;
  if (holidays !== null && typeof holidays === 'object' && holidays[now.dateKey]) return false;
  const windows = Array.isArray(config.peakWindows) ? config.peakWindows : [];
  for (const window of windows) {
    if (!Array.isArray(window) || window.length < 2) continue;
    const [start, end] = window;
    if (now.hour >= start && now.hour < end) return true;
  }
  return false;
}

/** Anchor table normalised to offsets from `curfewStart`, ascending. */
function anchorPairs(config, curfewStart) {
  const raw = Array.isArray(config.anchors) ? config.anchors : [];
  const pairs = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const at = timeOfDay(entry[0]);
    const tokens = Number(entry[1]);
    if (at === null || !Number.isFinite(tokens)) continue;
    pairs.push({ offset: mod(at - curfewStart, 1440), tokens });
  }
  pairs.sort((a, b) => a.offset - b.offset);
  return pairs;
}

/**
 * The token budget at one point of the curfew window.
 *
 * @param progress - 0 at `curfewStart`, 1 at `lightsOut`.
 * @param config - effective configuration.
 * @returns the budget in tokens, or `null` when the anchor table is unusable.
 */
export function budgetFor(progress, config) {
  const curfewStart = timeOfDay(config.curfewStart);
  if (curfewStart === null || progress === null) return null;
  const pairs = anchorPairs(config, curfewStart);
  if (pairs.length === 0) return null;
  if (pairs.length === 1) return Math.round(pairs[0].tokens);

  const lightsOut = timeOfDay(config.lightsOut);
  const length = lightsOut === null ? 0 : mod(lightsOut - curfewStart, 1440);
  const elapsed = progress * length;

  // `step` holds each anchor's budget for the whole interval that follows it.
  if (config.curve === 'step') {
    let tokens = pairs[0].tokens;
    for (const pair of pairs) {
      if (elapsed < pair.offset) break;
      tokens = pair.tokens;
    }
    return Math.round(tokens);
  }

  const first = pairs[0];
  const last = pairs[pairs.length - 1];

  // `easeIn` accelerates across the whole window between the outer anchors.
  if (config.curve === 'easeIn') {
    const span = last.offset - first.offset;
    const ratio = span <= 0 ? 1 : Math.min(1, Math.max(0, (elapsed - first.offset) / span));
    return Math.round(first.tokens + (last.tokens - first.tokens) * ratio * ratio);
  }

  // `linear` (default) interpolates piecewise, so it lands exactly on every anchor.
  if (elapsed <= first.offset) return Math.round(first.tokens);
  for (let index = 1; index < pairs.length; index += 1) {
    const previous = pairs[index - 1];
    const current = pairs[index];
    if (elapsed <= current.offset) {
      const span = current.offset - previous.offset;
      const ratio = span <= 0 ? 0 : (elapsed - previous.offset) / span;
      return Math.round(previous.tokens + (current.tokens - previous.tokens) * ratio);
    }
  }
  return Math.round(last.tokens);
}

function describe(now, config, curfewState, progress, peak) {
  const clock = `${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}`;
  const where = now.debug ? `${now.dateKey} ${clock} (debug)` : `${now.dateKey} ${clock}`;
  const parts = [where];
  if (peak) parts.push('peak hours');
  if (curfewState === WINDING) parts.push(`curfew ${(progress * 100).toFixed(0)}%`);
  else if (curfewState === LIGHTS_OUT) parts.push('after lights-out');
  else if (!peak) parts.push('valley, before curfew');
  return parts.join(' · ');
}

/**
 * Decide what the AI is doing right now.
 *
 * @param now - local fields from `clock.resolveNow`.
 * @param config - effective configuration.
 * @returns the verdict: `state`, the canned `reply` or the clamped `maxTokens`, and why.
 */
export function resolveDuty(now, config) {
  const curfewStart = timeOfDay(config.curfewStart);
  const lightsOut = timeOfDay(config.lightsOut);
  const wakeUp = timeOfDay(config.wakeUp);

  let curfewState = ON_DUTY;
  let progress = null;

  if (curfewStart !== null && lightsOut !== null && withinWindow(now.minutes, curfewStart, lightsOut)) {
    curfewState = WINDING;
    const length = mod(lightsOut - curfewStart, 1440);
    progress = length === 0 ? 1 : mod(now.minutes - curfewStart, 1440) / length;
  } else if (lightsOut !== null && wakeUp !== null && withinWindow(now.minutes, lightsOut, wakeUp)) {
    curfewState = LIGHTS_OUT;
  }

  const peak = config.peakShift !== false && isPeak(now, config);
  const state = Math.max(curfewState, peak ? OFF_DUTY : ON_DUTY);

  let maxTokens = null;
  let reply = null;
  if (state === WINDING) maxTokens = budgetFor(progress, config);
  else if (state === OFF_DUTY) reply = config.offDutyReply;
  else if (state === LIGHTS_OUT) reply = config.lightsOutReply;

  return {
    state,
    name: STATE_NAME[state],
    reply,
    maxTokens,
    progress,
    peak,
    reason: describe(now, config, curfewState, progress, peak),
  };
}
