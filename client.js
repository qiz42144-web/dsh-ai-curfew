/**
 * Client half of dsh-ai-curfew.
 *
 * Two surfaces, both reading the Host's own verdict from `/ai-curfew/state.json`
 * rather than recomputing the schedule: a status capsule beside Settings, and a
 * settings page showing the day as a 24-hour band plus the command reference.
 * Recomputing in the browser would let the two halves disagree about the time.
 *
 * The Host route is fenced by `connection.requestRejection`; this half only ever
 * issues a same-origin GET.
 *
 * Layout the page cannot do without — the band, the legend swatches, the command
 * grid — is inline rather than in the stylesheet. The stylesheet is optional by
 * nature: `styles.insert` is not always provided, and a page that silently loses
 * all of its CSS renders exactly like the unstyled column this started as.
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
    const RETRY_MS = 3000;
    const BLOCKS = 96; // one per quarter hour
    const STYLE_ID = 'dsh-ai-curfew-style';

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
    // must read the same way whatever the active theme does with its aliases.
    const BAND_COLOR = {
      'on-duty': '#2f9e6b',
      winding: '#d6a93b',
      'off-duty': '#8a8f98',
      'lights-out': '#c0563f',
    };

    const COMMANDS = [
      ['/curfew', '看班表：当前判定、预算与依据'],
      ['/curfew overtime 30m', '强制加班 30 分钟，宵禁暂停'],
      ['/curfew off', '立刻下班'],
      ['/curfew auto', '恢复自动班表，取消全部手动覆盖'],
      ['/curfew debug 01:30', '时间机器：假装现在是这个时刻'],
      ['/curfew debug clear', '回到真实时间'],
    ];

    const MONO = 'ui-monospace, "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace';

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
      .ai-curfew-page { display: flex; flex-direction: column; font-size: 0.92em; max-width: 46em; }
      .ai-curfew-section { font-weight: 600; margin: 1.1em 0 0.4em; }
      .ai-curfew-muted { opacity: 0.68; font-size: 0.88em; }
      .ai-curfew-axis > span { font-variant-numeric: tabular-nums; }
      .ai-curfew-command > code { white-space: nowrap; }
    `;

    /**
     * Insert the stylesheet, preferring the runner's owned seat.
     *
     * `styles.insert` is not guaranteed: the runner may provide no style seat at
     * all, and treating that as "no styles needed" leaves the page unstyled
     * rather than merely unthemed. Falls back to a package-owned `style` element.
     */
    function insertStyles() {
      if (styles !== undefined && styles !== null && typeof styles.insert === 'function') {
        return styles.insert(STYLESHEET);
      }
      try {
        const existing = document.getElementById(STYLE_ID);
        if (existing !== null) existing.remove();
        const tag = document.createElement('style');
        tag.id = STYLE_ID;
        tag.textContent = STYLESHEET;
        document.head.append(tag);
        return () => {
          tag.remove();
        };
      } catch {
        return () => {};
      }
    }

    function useCurfewState() {
      const [state, setState] = React.useState(null);

      React.useEffect(() => {
        let live = true;
        let timer = null;

        function schedule(delay) {
          if (!live) return;
          timer = setTimeout(read, delay);
        }

        function read() {
          Promise.resolve()
            .then(() => fetch(STATE_URL, { cache: 'no-store' }))
            .then((response) => (response && response.ok ? response.json() : null))
            .then((next) => {
              if (!live) return;
              if (next === null || typeof next !== 'object') {
                // The Host may still be wiring its routes, or the fence may not
                // have admitted this page yet. Come back soon rather than in a
                // minute, so a cold start heals on its own instead of sitting on
                // the fallback until something remounts the component.
                schedule(RETRY_MS);
                return;
              }
              setState(next);
              schedule(POLL_MS);
            })
            .catch(() => {
              if (live) schedule(RETRY_MS);
            });
        }

        read();
        return () => {
          live = false;
          if (timer !== null) clearTimeout(timer);
        };
      }, []);

      return state;
    }

    function faceFor(state) {
      if (state === null || typeof state !== 'object' || typeof state.state !== 'string') return '⚪';
      return FACE[state.state] ?? '⚪';
    }

    function capsuleText(state) {
      if (state === null || typeof state !== 'object' || typeof state.state !== 'string') return 'AI 熄灯';
      const face = faceFor(state);
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
     * with, and the page says so.
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

    const BAND_STYLE = {
      display: 'flex',
      width: '100%',
      height: '26px',
      borderRadius: '6px',
      overflow: 'hidden',
    };

    function ScheduleBand(props) {
      const schedule = props !== null && typeof props === 'object' ? props.schedule : null;
      const nowMinutes = props !== null && typeof props.nowMinutes === 'number' ? props.nowMinutes : null;

      const blocks = [];
      for (let index = 0; index < BLOCKS; index += 1) {
        const minute = index * (1440 / BLOCKS);
        const kind = classify(minute, schedule);
        blocks.push(
          h('span', {
            key: index,
            title: `${clockLabel(minute)} ${BAND_LABEL[kind]}`,
            style: { flex: '1 1 0', minWidth: '0', background: BAND_COLOR[kind] },
          }),
        );
      }

      const ticks = [0, 180, 360, 540, 720, 900, 1080, 1260, 1440].map((minute) =>
        h('span', { key: minute }, clockLabel(minute)),
      );

      const cursor =
        nowMinutes === null
          ? null
          : h('div', {
              title: `现在 ${clockLabel(nowMinutes)}`,
              style: {
                position: 'absolute',
                top: '-3px',
                bottom: '-3px',
                width: '2px',
                marginLeft: '-1px',
                background: 'currentColor',
                opacity: '0.75',
                left: `${(nowMinutes / 1440) * 100}%`,
              },
            });

      return h(
        'div',
        null,
        h(
          'div',
          { style: { position: 'relative' } },
          h('div', { className: 'ai-curfew-band', style: BAND_STYLE }, blocks),
          cursor,
        ),
        h(
          'div',
          {
            className: 'ai-curfew-axis ai-curfew-muted',
            style: { display: 'flex', justifyContent: 'space-between', marginTop: '0.35em' },
          },
          ticks,
        ),
      );
    }

    function Legend() {
      return h(
        'div',
        { style: { display: 'flex', flexWrap: 'wrap', gap: '0.85em', marginTop: '0.6em' } },
        Object.keys(BAND_LABEL).map((kind) =>
          h(
            'span',
            { key: kind, style: { display: 'inline-flex', alignItems: 'center', gap: '0.35em' } },
            h('i', {
              style: {
                width: '0.8em',
                height: '0.8em',
                borderRadius: '2px',
                background: BAND_COLOR[kind],
                display: 'inline-block',
              },
            }),
            BAND_LABEL[kind],
          ),
        ),
      );
    }

    const CARD_STYLE = {
      display: 'flex',
      flexDirection: 'column',
      gap: '0.3em',
      border: '1px solid rgba(127, 127, 127, 0.3)',
      borderRadius: '8px',
      padding: '0.75em 0.9em',
    };

    const ROW_STYLE = {
      display: 'grid',
      gridTemplateColumns: 'minmax(0, 15em) minmax(0, 1fr)',
      gap: '0.75em',
      alignItems: 'baseline',
      padding: '0.2em 0',
    };

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

      let budget = '还没读到班表';
      if (state !== null && typeof state === 'object') {
        if (!state.enabled) budget = '不干预（已停用）';
        else if (typeof state.reply === 'string') budget = `不发送请求，只回 ${state.reply}`;
        else if (typeof state.maxTokens === 'number') budget = `${state.maxTokens} tokens`;
        else budget = '不干预';
      }

      return h(
        'div',
        { className: 'ai-curfew-page' },
        h(
          'div',
          { style: CARD_STYLE },
          h('div', { style: { fontSize: '1.05em', fontWeight: '500' } }, `现在：${capsuleText(state)}`),
          h('div', { className: 'ai-curfew-muted' }, `依据：${state?.reason ?? '—'}`),
          h('div', { className: 'ai-curfew-muted' }, `预算：${budget}`),
          suspensionNote === null ? null : h('div', { className: 'ai-curfew-muted' }, suspensionNote),
        ),
        h('div', { className: 'ai-curfew-section' }, '一天的样子（工作日模板）'),
        h(ScheduleBand, { schedule, nowMinutes: state?.nowMinutes }),
        h(Legend, null),
        h(
          'div',
          { className: 'ai-curfew-muted', style: { marginTop: '0.5em' } },
          '周末与法定节假日全天按低谷计，因此不上班的高峰段在那些天不会出现。竖线是现在。',
        ),
        h('div', { className: 'ai-curfew-section' }, '命令'),
        h(
          'div',
          null,
          COMMANDS.map(([line, description]) =>
            h(
              'div',
              { key: line, className: 'ai-curfew-command', style: ROW_STYLE },
              h('code', { style: { fontFamily: MONO, fontSize: '0.9em' } }, line),
              h('span', { style: { opacity: '0.8' } }, description),
            ),
          ),
        ),
        h(
          'div',
          { className: 'ai-curfew-muted', style: { marginTop: '0.5em' } },
          '命令不经过模型，所以 AI 下班时也能用 —— 这是把自己关在门外之后的逃生口。',
        ),
      );
    }

    return {
      // `slots` is the one hard dependency: without it there is nothing to render into.
      inject: ['slots'],
      apply(ctx) {
        ctx.effect(() => insertStyles(), 'ai-curfew-style');

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
