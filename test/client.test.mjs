/**
 * The client half: its schedule band, its capsule, and its polling loop.
 *
 * `client.js` is served as a single self-contained bundle, so it cannot import a
 * shared module and its internals are not exported. It is loaded here through a
 * stub module loader with a minimal React, which is enough to call the
 * registered components and inspect the element tree they return.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let definition = null;
globalThis.window = { __ModuleLoader__: { load: (registered) => { definition = registered; } } };

let mockState = null;
// Effects are opt-in: the render tests do not want a polling loop running, and
// the polling test wants nothing else.
let runEffects = false;
const noop = () => {};
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: () => [mockState, noop],
  useEffect: (callback) => {
    if (runEffects) callback();
  },
};

// Timers and fetch are captured rather than executed, so the loop's scheduling
// can be asserted without waiting three seconds.
const scheduled = [];
const realSetTimeout = globalThis.setTimeout;
const realFetch = globalThis.fetch;
globalThis.setTimeout = (callback, delay) => {
  scheduled.push(delay);
  return 0;
};

await import('../client.js');
assert.notEqual(definition, null, 'the bundle must register itself with the module loader');
assert.equal(definition.id, 'dsh-ai-curfew');

function requireStub(name) {
  if (name === 'react') return React;
  throw new Error(`the client half may only require react, got ${name}`);
}

const client = definition.factory(requireStub, { insert: () => noop });

const registrations = [];
client.apply({
  effect: (callback) => { callback(); },
  slots: {
    inject: (slot, render) => { registrations.push({ slot, render }); },
    register: (options, Component) => ({ options, Component }),
  },
});

function componentFor(slot) {
  const entry = registrations.find((candidate) => candidate.slot === slot);
  assert.notEqual(entry, undefined, `${slot} must be injected`);
  return entry.render().Component;
}

/** Let the promise chain inside one poll settle. */
const flush = () => new Promise((resolve) => realSetTimeout(resolve, 0));

async function pollOnce({ response }) {
  scheduled.length = 0;
  globalThis.fetch = () => Promise.resolve(response);
  runEffects = true;
  try {
    componentFor('sidebar.footer.action')({ wide: true });
    await flush();
  } finally {
    runEffects = false;
    globalThis.fetch = realFetch;
  }
  return scheduled.slice();
}

const schedule = {
  wakeUp: '09:00',
  curfewStart: '23:00',
  lightsOut: '03:00',
  peakShift: true,
  peakWindows: [
    [9, 12],
    [14, 18],
  ],
};

/** React flattens array children; the stub element does not. */
function flatten(children) {
  const out = [];
  for (const child of children ?? []) {
    if (Array.isArray(child)) out.push(...flatten(child));
    else out.push(child);
  }
  return out;
}

/**
 * Walk the returned element tree and collect the band's block colours in order.
 *
 * Function components are invoked as React would, since `createElement` only
 * records the element and never renders it.
 */
function bandColours(element, found = []) {
  if (element === null || typeof element !== 'object') return found;
  const node = typeof element.type === 'function' ? element.type(element.props) : element;
  if (node === null || typeof node !== 'object') return found;
  if (node.props?.className === 'ai-curfew-band') {
    for (const child of flatten(node.children)) found.push(child.props.style.background);
    return found;
  }
  for (const child of flatten(node.children)) bandColours(child, found);
  return found;
}

const COLOUR = { 'on-duty': '#2f9e6b', winding: '#d6a93b', 'off-duty': '#8a8f98', 'lights-out': '#c0563f' };
const KIND = Object.fromEntries(Object.entries(COLOUR).map(([kind, colour]) => [colour, kind]));
const blockAt = (colourList, minutes) => KIND[colourList[minutes / 15]];

test('the settings page is registered and draws one block per quarter hour', () => {
  mockState = { state: 'lights-out', schedule };
  const colours = bandColours(componentFor('settings.section')());
  assert.equal(colours.length, 96);
  assert.ok(colours.every((colour) => typeof colour === 'string'), 'every block must be painted');
});

test('the band reproduces the configured day', () => {
  mockState = { state: 'lights-out', schedule };
  const colours = bandColours(componentFor('settings.section')());

  assert.equal(blockAt(colours, 0), 'winding', '00:00 is inside the window that opened at 23:00');
  assert.equal(blockAt(colours, 2 * 60 + 45), 'winding', 'the window wraps midnight');
  assert.equal(blockAt(colours, 3 * 60), 'lights-out');
  assert.equal(blockAt(colours, 8 * 60 + 45), 'lights-out');
  assert.equal(blockAt(colours, 9 * 60), 'off-duty', '09:00 opens a peak window');
  assert.equal(blockAt(colours, 11 * 60 + 45), 'off-duty');
  assert.equal(blockAt(colours, 12 * 60), 'on-duty', 'the middle of the day is valley');
  assert.equal(blockAt(colours, 13 * 60 + 45), 'on-duty');
  assert.equal(blockAt(colours, 14 * 60), 'off-duty');
  assert.equal(blockAt(colours, 17 * 60 + 45), 'off-duty');
  assert.equal(blockAt(colours, 18 * 60), 'on-duty');
  assert.equal(blockAt(colours, 22 * 60 + 45), 'on-duty');
  assert.equal(blockAt(colours, 23 * 60), 'winding');
});

test('turning the peak gate off leaves a pure curfew', () => {
  mockState = { state: 'on-duty', schedule: { ...schedule, peakShift: false } };
  const colours = bandColours(componentFor('settings.section')());

  assert.equal(blockAt(colours, 10 * 60), 'on-duty', 'a weekday morning is no longer off duty');
  assert.equal(blockAt(colours, 1 * 60), 'winding');
});

test('a missing schedule degrades to a flat band instead of throwing', () => {
  mockState = null;
  const colours = bandColours(componentFor('settings.section')());
  assert.equal(colours.length, 96);
  assert.ok(colours.every((colour) => colour === COLOUR['on-duty']));
});

/** Collect every string rendered anywhere in the tree. */
function texts(element, found = []) {
  if (typeof element === 'string') { found.push(element); return found; }
  if (element === null || typeof element !== 'object') return found;
  const node = typeof element.type === 'function' ? element.type(element.props) : element;
  if (node === null || typeof node !== 'object') return found;
  for (const child of flatten(node.children)) texts(child, found);
  return found;
}

test('the settings page distinguishes overtime from being switched off', () => {
  mockState = { enabled: false, state: 'on-duty', scheduleState: 'off-duty', overtimeMs: 25 * 60000, schedule };
  const overtime = texts(componentFor('settings.section')()).join(' | ');
  assert.match(overtime, /🟢 上班中/, 'the effective verdict is what is shown');
  assert.match(overtime, /加班中（宵禁暂停，还剩约 25 分钟）/, 'overtime is named as the shift it is');
  assert.match(overtime, /按班表本应是已下班/, 'and the schedule is kept as context');

  mockState = { enabled: false, state: 'on-duty', scheduleState: 'winding', overtimeMs: 0, schedule };
  const disabled = texts(componentFor('settings.section')()).join(' | ');
  assert.match(disabled, /插件已停用；按班表本应是打烊中/);
  assert.doesNotMatch(disabled, /加班中/, 'a plugin switched off is not on overtime');

  mockState = { enabled: true, state: 'winding', scheduleState: 'winding', schedule };
  const acting = texts(componentFor('settings.section')()).join(' | ');
  assert.doesNotMatch(acting, /已停用/);
  assert.doesNotMatch(acting, /加班中/);
});

test('the capsule is registered beside Settings', () => {
  mockState = { state: 'winding', progress: 0.46, reason: 'test' };
  const Capsule = componentFor('sidebar.footer.action');

  assert.equal(Capsule({ wide: true }).children[0].children[0], '🌙 打烊中 46%');
  assert.equal(Capsule({ wide: false }).children[0].children[0], '🌙', 'the 56px rail shows the face alone');

  mockState = { state: 'lights-out' };
  assert.equal(Capsule({ wide: true }).children[0].children[0], '🔴 明天再说');

  mockState = null;
  assert.equal(Capsule({ wide: true }).children[0].children[0], 'AI 熄灯');
  assert.equal(Capsule({ wide: false }).children[0].children[0], '⚪');
});

// --- the polling loop -------------------------------------------------------

test('a poll that comes back empty retries in seconds, not a minute', async () => {
  // The regression a cold boot exposed: the Host route was not serving yet, so
  // the first poll failed and the capsule sat on its fallback text until the
  // plugin was toggled and the component remounted. A failed poll has to come
  // back quickly so a cold start heals on its own.
  const rejected = await pollOnce({ response: { ok: false } });
  assert.deepEqual(rejected, [3000]);

  const threw = await pollOnce({ response: null });
  assert.deepEqual(threw, [3000], 'a thrown fetch must be retried the same way');
});

test('a poll that lands settles into the cadence the schedule implies', async () => {
  const settled = await pollOnce({
    response: { ok: true, json: () => Promise.resolve({ state: 'on-duty', schedule }) },
  });
  assert.deepEqual(settled, [60000], 'with no clock reading to work from, fall back to a flat minute');
});

test('the capsule wakes just after the next schedule edge, not a minute later', async () => {
  // The complaint that produced this: at 14:00 the capsule could sit visibly
  // stale for up to a minute, because it polled on a flat interval instead of
  // sleeping to a boundary it already knew about.
  const reading = (minutes, extra = {}) => ({
    ok: true,
    json: () =>
      Promise.resolve({
        state: 'on-duty',
        nowMinutes: minutes,
        at: Date.now(),
        schedule,
        ...extra,
      }),
  });

  // 13:58 -> the 14:00 peak edge is two minutes out.
  assert.deepEqual(await pollOnce({ response: reading(13 * 60 + 58) }), [122000]);

  // 13:00 -> an hour out, so the ceiling applies and the grace still lands after it.
  assert.deepEqual(await pollOnce({ response: reading(13 * 60) }), [302000]);

  // The dead of night: the next edge is hours away, same ceiling.
  assert.deepEqual(await pollOnce({ response: reading(4 * 60) }), [302000]);
});

test('an overtime shift wakes the capsule when it ends', async () => {
  const shift = {
    ok: true,
    json: () =>
      Promise.resolve({
        state: 'on-duty',
        nowMinutes: 14 * 60,
        at: Date.now(),
        overtimeMs: 90 * 60000,
        schedule,
      }),
  };
  assert.deepEqual(await pollOnce({ response: shift }), [302000], 'capped, then the grace');
});

test('inside the curfew it keeps polling, because the percentage moves', async () => {
  const winding = {
    ok: true,
    json: () =>
      Promise.resolve({
        state: 'winding',
        nowMinutes: 23 * 60 + 30,
        at: Date.now(),
        schedule,
      }),
  };
  assert.deepEqual(await pollOnce({ response: winding }), [60000]);
});

// --- the stylesheet ---------------------------------------------------------

test('the stylesheet falls back to a style element when the runner offers no seat', () => {
  // `styles.insert` is not guaranteed, and treating its absence as "no styles
  // needed" renders the whole page as an unstyled column. The fallback is what
  // makes the page look like a page.
  const appended = [];
  globalThis.document = {
    getElementById: () => null,
    createElement: () => ({ id: '', textContent: '', remove() {} }),
    head: { append: (tag) => appended.push(tag) },
  };

  try {
    const withoutSeat = definition.factory(requireStub, undefined);
    withoutSeat.apply({
      effect: (callback) => { callback(); },
      slots: { inject: () => {}, register: (options, Component) => ({ options, Component }) },
    });
  } finally {
    delete globalThis.document;
  }

  assert.equal(appended.length, 1, 'exactly one style element');
  assert.equal(appended[0].id, 'dsh-ai-curfew-style');
  assert.match(appended[0].textContent, /\.ai-curfew-capsule/);
  assert.match(appended[0].textContent, /\.ai-curfew-page/);
});

// --- the command reference --------------------------------------------------

test('the page lists every command, including the ones that are easy to forget', () => {
  mockState = { enabled: true, state: 'on-duty', scheduleState: 'on-duty', schedule };
  const rendered = texts(componentFor('settings.section')()).join(' | ');

  for (const line of ['/curfew', '/curfew overtime 30m', '/curfew off', '/curfew auto', '/curfew debug 01:30', '/curfew debug clear']) {
    assert.ok(rendered.includes(line), `${line} must appear in the reference`);
  }
  assert.match(rendered, /命令不经过模型/, 'and the page says why the commands are the way out');
});
