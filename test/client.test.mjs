/**
 * The client half's schedule band.
 *
 * `client.js` is served as a single self-contained bundle, so it cannot import a
 * shared module and its internals are not exported. It is loaded here through a
 * stub module loader with a minimal React, which is enough to call the settings
 * component and inspect the element tree it returns.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

let definition = null;
globalThis.window = { __ModuleLoader__: { load: (registered) => { definition = registered; } } };

let mockState = null;
const noop = () => {};
const React = {
  createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
  useState: () => [mockState, noop],
  useEffect: noop,
};

await import('../client.js');
assert.notEqual(definition, null, 'the bundle must register itself with the module loader');
assert.equal(definition.id, 'dsh-ai-curfew');

const client = definition.factory(
  (name) => {
    if (name === 'react') return React;
    throw new Error(`the client half may only require react, got ${name}`);
  },
  { insert: () => noop },
);

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
