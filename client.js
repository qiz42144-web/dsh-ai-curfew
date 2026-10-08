/**
 * Client half of dsh-ai-curfew.
 *
 * Two surfaces, both reading the Host's own verdict from `/ai-curfew/state.json`
 * rather than recomputing the schedule: a status capsule beside Settings, and a
 * settings page drawing the day as a 24-hour band. Recomputing in the browser
 * would let the two halves disagree about what time it is.
 *
 * The Host route is fenced by `connection.requestRejection`; this half only ever
 * issues a same-origin GET.
 *
 * Hand-written plugin: no build step, no JSX, no bare imports. `react` is the
 * only module this factory may require, and only the documented hooks
 * (`useState` / `useEffect`) are used — `useSyncExternalStore` is not in the
 * baseline, and a missing export takes the whole page down.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-curfew',
  factory(require, styles) {
    const React = require('react');
    const h = React.createElement;

    const STATE_URL = '/ai-curfew/state.json';
    const POLL_MS = 60000;
    const BLOCKS = 96; // one per quarter hour

    const FACE = {
      'on-duty': '🟢',
      winding: '🌙',
      'off-duty': '⚫',
      'lights-out': '🔴',
    };
    const NAME = {
      'on-duty': '上班中',
      winding: '打烊中',
      'off-duty': '已下班',
      'lights-out': '明天再说',
    };
    const BAND_LABEL = {
      'on-duty': '上班',
      winding: '打烊',
      'off-duty': '高峰下班',
      'lights-out': '熄灯',
    };
    // Concrete colours rather than theme tokens: this band is a diagram, and it
    // must render the same way whatever the active theme does with its aliases.
    const BAND_COLOR = {
      'on-duty': '#2f9e6b',
      winding: '#d6a93b',
      'off-duty': '#8a8f98',
      'lights-out': '#c0563f',
    };

    const STYLESHEET = `
      .ai-curfew-capsule {
        display: inline-flex;
        align-items: center;
        gap: 0.35em;
        padding: 0.15em 0.5em;
        border-radius: 999px;
        border: 1px solid rgba(127, 127, 127, 0.35);
        font-size: 0.85em;
        line-height: 1.6;
        white-space: nowrap;
        cursor: default;
      }
      .ai-curfew-capsule[data-state='off-duty'],
      .ai-curfew-capsule[data-state='lights-out'] { opacity: 0.75; }
      .ai-curfew-page { display: flex; flex-direction: column; gap: 0.7em; font-size: 0.9em; }
      .ai-curfew-now { font-weight: 500; }
      .ai-curfew-band { display: flex; width: 100%; height: 26px; border-radius: 6px; overflow: hidden; }
      .ai-curfew-band > span { flex: 1 1 0; }
      .ai-curfew-axis { display: flex; justify-content: space-between; opacity: 0.7; font-size: 0.85em; }
      .ai-curfew-legend { display: flex; flex-wrap: wrap; gap: 0.9em; opacity: 0.85; font-size: 0.85em; }
      .ai-curfew-legend > span { display: inline-flex; align-items: center; gap: 0.35em; }
      .ai-curfew-legend > span > i { width: 0.8em; height: 0.8em; border-radius: 2px; display: inline-block; }
      .ai-curfew-note { opacity: 0.65; font-size: 0.85em; }
    `;

    function useCurfewState() {
      const [state, setState] = React.useState(null);

      React.useEffect(() => {
        let live = true;
        const read = () => {
          Promise.resolve()
            .then(() => fetch(STATE_URL, { cache: 'no-store' }))
            .then((response) => (response && response.ok ? response.json() : null))
            .then((next) => {
              if (live && next !== null && typeof next === 'object') setState(next);
            })
            .catch(() => {
              /* keep the last reading: a Host that stopped answering is not worth a red badge */
            });
        };

        read();
        const timer = setInterval(read, POLL_MS);
        return () => {
          live = false;
          clearInterval(timer);
        };
      }, []);

      return state;
    }

    function capsuleText(state) {
      if (state === null || typeof state !== 'object' || typeof state.state !== 'string') return 'AI 熄灯';
      const face = FACE[state.state] ?? '⚪';
      const name = NAME[state.state] ?? state.state;
      if (state.state === 'winding') {
        if (typeof state.progress === 'number') return `${face} ${name} ${Math.round(state.progress * 100)}%`;
        if (typeof state.maxTokens === 'number') return `${face} ${name} ${state.maxTokens}`;
      }
      return `${face} ${name}`;
    }

    function capsuleTitle(state) {
      if (state === null || typeof state !== 'object') return 'AI 熄灯（还没读到班表）';
      return state.reason ? `AI 熄灯 · ${state.reason}` : 'AI 熄灯';
    }

    function faceFor(state) {
      if (state === null || typeof state !== 'object' || typeof state.state !== 'string') return '⚪';
      return FACE[state.state] ?? '⚪';
    }

    function Capsule(ownerProps) {
      const state = useCurfewState();
      const wide = ownerProps !== null && typeof ownerProps === 'object' && ownerProps.wide === true;

      return h(
        'div',
        {
          className: 'ai-curfew-capsule',
          'data-state': typeof state?.state === 'string' ? state.state : 'unknown',
          title: capsuleTitle(state),
          'aria-label': capsuleTitle(state),
        },
        // The 56px rail has room for the face; the wide sidebar gets the words.
        h('span', null, wide ? capsuleText(state) : faceFor(state)),
      );
    }

    // --- the schedule band --------------------------------------------------

    const CLOCK = /^(\d{1,2}):(\d{2})$/;

    function minutesOf(text) {
      const match = CLOCK.exec(String(text ?? '').trim());
      if (match === null) return null;
      const hour = Number(match[1]);
      const minute = Number(match[2]);
      if (hour > 23 || minute > 59) return null;
      return hour * 60 + minute;
    }

    function inWindow(minute, start, end) {
      if (start === null || end === null) return false;
      const length = (((end - start) % 1440) + 1440) % 1440;
      if (length === 0) return false;
      return ((((minute - start) % 1440) + 1440) % 1440) < length;
    }

    function clockLabel(minute) {
      const wrapped = ((minute % 1440) + 1440) % 1440;
      return `${String(Math.floor(wrapped / 60)).padStart(2, '0')}:${String(wrapped % 60).padStart(2, '0')}`;
    }

    /**
     * The shape of one generic weekday.
     *
     * Weekends and statutory holidays are valley all day, which this schematic
     * does not try to draw: it shows the weekday template the Host is configured
     * with, and the settings page says so.
     */
    function classify(minute, schedule) {
      if (schedule === null || typeof schedule !== 'object') return 'on-duty';
      const wake = minutesOf(schedule.wakeUp);
      const curfew = minutesOf(schedule.curfewStart);
      const dark = minutesOf(schedule.lightsOut);

      if (inWindow(minute, curfew, dark)) return 'winding';
      if (inWindow(minute, dark, wake)) return 'lights-out';

      if (schedule.peakShift !== false && Array.isArray(schedule.peakWindows)) {
        const hour = Math.floor(minute / 60);
        for (const window of schedule.peakWindows) {
          if (Array.isArray(window) && window.length >= 2 && hour >= window[0] && hour < window[1]) {
            return 'off-duty';
          }
        }
      }
      return 'on-duty';
    }

    function ScheduleBand(props) {
      const schedule = props !== null && typeof props === 'object' ? props.schedule : null;
      const blocks = [];
      for (let index = 0; index < BLOCKS; index += 1) {
        const minute = index * (1440 / BLOCKS);
        const kind = classify(minute, schedule);
        blocks.push(
          h('span', {
            key: index,
            title: `${clockLabel(minute)} ${BAND_LABEL[kind]}`,
            style: { background: BAND_COLOR[kind] },
          }),
        );
      }

      return h(
        'div',
        null,
        h('div', { className: 'ai-curfew-band' }, blocks),
        h(
          'div',
          { className: 'ai-curfew-axis' },
          h('span', null, '00:00'),
          h('span', null, '06:00'),
          h('span', null, '12:00'),
          h('span', null, '18:00'),
          h('span', null, '24:00'),
        ),
      );
    }

    function CurfewSettings() {
      const state = useCurfewState();
      const schedule = state !== null && typeof state === 'object' ? state.schedule : null;
      const suspended = state !== null && typeof state === 'object' && state.enabled === false;
      const overtimeMs = typeof state?.overtimeMs === 'number' ? state.overtimeMs : 0;
      const scheduleName = NAME[state?.scheduleState] ?? state?.scheduleState;

      // A suspended plugin is either on overtime or switched off outright, and
      // the difference matters: one is a shift the operator ordered, the other
      // is the plugin standing down entirely.
      const suspensionNote =
        !suspended || typeof scheduleName !== 'string'
          ? null
          : overtimeMs > 0
            ? `加班中（宵禁暂停，还剩约 ${Math.ceil(overtimeMs / 60000)} 分钟）；按班表本应是${scheduleName}。`
            : `插件已停用；按班表本应是${scheduleName}。`;

      const legend = Object.keys(BAND_LABEL).map((kind) =>
        h(
          'span',
          { key: kind },
          h('i', { style: { background: BAND_COLOR[kind] } }),
          BAND_LABEL[kind],
        ),
      );

      return h(
        'div',
        { className: 'ai-curfew-page' },
        h('div', { className: 'ai-curfew-now' }, `现在：${capsuleText(state)}`),
        suspensionNote === null ? null : h('div', { className: 'ai-curfew-note' }, suspensionNote),
        state?.reason ? h('div', { className: 'ai-curfew-note' }, `依据：${state.reason}`) : null,
        h(ScheduleBand, { schedule }),
        h('div', { className: 'ai-curfew-legend' }, legend),
        h(
          'div',
          { className: 'ai-curfew-note' },
          '这是一周的通用模板：周末与法定节假日全天按低谷计，因此不上班的高峰段在那些天不会出现。',
        ),
      );
    }

    return {
      // `slots` is the one hard dependency: without it there is nothing to render into.
      inject: ['slots'],
      apply(ctx) {
        try {
          if (styles !== undefined && styles !== null && typeof styles.insert === 'function') {
            ctx.effect(() => styles.insert(STYLESHEET), 'ai-curfew-style');
          }
        } catch {
          /* a missing stylesheet leaves an unstyled but working UI */
        }

        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            {
              name: 'sidebar.footer.action',
              id: 'ai-curfew',
              order: 60,
              label: () => 'AI 熄灯',
            },
            Capsule,
          ),
        );

        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            {
              name: 'settings.section',
              id: 'ai-curfew',
              order: 40,
              label: () => 'AI 熄灯',
            },
            CurfewSettings,
          ),
        );
      },
    };
  },
});
