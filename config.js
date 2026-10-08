/**
 * Configuration: built-in defaults plus an optional JSON overlay.
 *
 * The overlay lives at `$DSH_HOME/dsh-ai-curfew/config.json` and is re-read
 * whenever its mtime or size changes, so a running Host picks up edits without
 * a restart. Shallow merge: a key you set replaces the default wholesale, so
 * `anchors` and `holidays` are replaced, never merged element-wise.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/**
 * 2026 Chinese statutory holidays — DeepSeek bills these as all-day valley time.
 *
 * Data, not expression: the dates come from 《国务院办公厅关于 2026 年部分节假日
 * 安排的通知》(国办发明电〔2025〕7 号). Only days *off* are listed; every 调休
 * make-up workday in 2026 falls on a weekend, which the weekend rule already
 * covers. See PROVENANCE.md — this table must be extended every November once
 * the State Council publishes the following year's schedule.
 */
export const HOLIDAYS_2026 = {
  '2026-01-01': true, '2026-01-02': true, '2026-01-03': true, // 元旦
  '2026-02-15': true, '2026-02-16': true, '2026-02-17': true, // 春节 2/15–2/23
  '2026-02-18': true, '2026-02-19': true, '2026-02-20': true,
  '2026-02-21': true, '2026-02-22': true, '2026-02-23': true,
  '2026-04-04': true, '2026-04-05': true, '2026-04-06': true, // 清明
  '2026-05-01': true, '2026-05-02': true, '2026-05-03': true, // 劳动节 5/1–5/5
  '2026-05-04': true, '2026-05-05': true,
  '2026-06-19': true, '2026-06-20': true, '2026-06-21': true, // 端午
  '2026-09-25': true, '2026-09-26': true, '2026-09-27': true, // 中秋
  '2026-10-01': true, '2026-10-02': true, '2026-10-03': true, // 国庆 10/1–10/7
  '2026-10-04': true, '2026-10-05': true, '2026-10-06': true,
  '2026-10-07': true,
};

/** Everything the plugin reads. `debugNow` is the time machine used by tests and `/curfew debug`. */
export const DEFAULTS = {
  enabled: true,
  timezone: 'Asia/Shanghai',

  // The daily duty cycle, in `timezone` local time.
  //   wakeUp → curfewStart   on duty (subject to the peak gate)
  //   curfewStart → lightsOut winding: replies shrink along the curve
  //   lightsOut → wakeUp     lights out: nothing is sent, one canned reply
  wakeUp: '09:00',
  curfewStart: '23:00',
  lightsOut: '03:00',

  // Shrinking budget across the curfew window.
  curve: 'linear', // 'linear' | 'step' | 'easeIn'
  anchors: [
    ['23:00', 2048],
    ['00:00', 1600],
    ['01:00', 800],
    ['02:00', 320],
    ['03:00', 64],
  ],

  // Canned replies for the states that send no request at all.
  offDutyReply: '。',
  lightsOutReply: '明天再说。',

  // Peak/valley gate. Peak = Mon–Fri, minus weekends and statutory holidays.
  peakShift: true,
  peakWindows: [
    [9, 12],
    [14, 18],
  ],
  weekendValley: true,
  holidays: HOLIDAYS_2026,

  // Safety and scope.
  safetyMaxTokens: 16,
  // Optional: a valid reasoning-effort id to drop to during the curfew. Left
  // unset by default, because the accepted ids belong to the provider and model
  // and guessing one would be worse than leaving the machine's own choice alone.
  windingReasoningEffort: null,
  // Soft lever: let the shrinking look like tiredness rather than truncation.
  // One line per quarter of the curfew window, in order.
  tiredPersona: true,
  tierTexts: [
    '可以正常回答，但不要主动扩展话题。',
    '回答控制在三句以内。',
    '只回答被问到的，一句话说完。',
    '最多 20 字。',
  ],
  // Hard lever: a turn that is already running must not start new work once the
  // AI is off the clock.
  denyToolsWhenOffDuty: true,
  exemptSessions: [],
  dryRun: false, // decide and record, but still send the request
  debugNow: null, // 'HH:MM' or 'YYYY-MM-DD HH:MM'; null = real clock
};

const CONFIG_DIR = 'dsh-ai-curfew';

/** Resolve `$DSH_HOME` the way the rest of the ecosystem does. */
export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

export function configPath() {
  return join(dshHome(), CONFIG_DIR, 'config.json');
}

/** Read the overlay once. Never throws: a broken file logs and yields `{}`. */
function readOverlay(log) {
  const file = configPath();
  try {
    const stat = statSync(file);
    return { file, key: `${stat.mtimeMs}:${stat.size}`, text: readFileSync(file, 'utf8') };
  } catch (error) {
    if (error?.code !== 'ENOENT') log(`[ai-curfew] cannot read ${file}: ${error?.message ?? error}`);
    return null;
  }
}

/**
 * Build a reader that returns the effective configuration.
 *
 * The overlay is stat-ed on every call and only re-parsed when it changed, so
 * the cost per model call is one `stat` on a path that usually does not exist.
 *
 * @param log - sink for configuration warnings.
 * @returns a function returning a fresh, frozen configuration object.
 */
export function createConfigReader(log = () => {}) {
  let cacheKey = null;
  let cachedOverlay = {};

  return function read() {
    const snapshot = readOverlay(log);
    if (snapshot === null) {
      cacheKey = null;
      cachedOverlay = {};
    } else if (snapshot.key !== cacheKey) {
      cacheKey = snapshot.key;
      try {
        const parsed = JSON.parse(snapshot.text);
        cachedOverlay = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
      } catch (error) {
        log(`[ai-curfew] ${snapshot.file} is not valid JSON, using defaults: ${error?.message ?? error}`);
        cachedOverlay = {};
      }
    }

    const config = { ...DEFAULTS, ...cachedOverlay };
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: config.timezone });
    } catch {
      log(`[ai-curfew] unknown timezone "${config.timezone}", falling back to ${DEFAULTS.timezone}`);
      config.timezone = DEFAULTS.timezone;
    }
    return config;
  };
}
