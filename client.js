/**
 * Client half of dsh-ai-curfew: a status capsule beside the sidebar's Settings.
 *
 * The capsule reads the verdict from the Host's own JSON route rather than
 * recomputing it, so the two halves cannot disagree about what time it is. The
 * Host route is fenced by `connection.requestRejection`; this half only ever
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

    const STYLESHEET = `
      .ai-curfew-capsule {
        display: inline-flex;
        align-items: center;
        gap: 0.35em;
        padding: 0.15em 0.5em;
        border-radius: 999px;
        border: 1px solid var(--dsw-border-1, rgba(127, 127, 127, 0.35));
        background: var(--dsw-layer-2, transparent);
        color: var(--dsw-label-2, inherit);
        font-size: 0.85em;
        line-height: 1.6;
        white-space: nowrap;
        cursor: default;
      }
      .ai-curfew-capsule[data-state='off-duty'],
      .ai-curfew-capsule[data-state='lights-out'] {
        opacity: 0.75;
      }
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
      if (state === null || typeof state.state !== 'string') return 'AI 熄灯';
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

    function Capsule(ownerProps) {
      const state = useCurfewState();
      const text = capsuleText(state);
      const wide = ownerProps !== null && typeof ownerProps === 'object' && ownerProps.wide === true;

      return h(
        'div',
        {
          className: 'ai-curfew-capsule',
          'data-state': state?.state ?? 'unknown',
          title: capsuleTitle(state),
          'aria-label': capsuleTitle(state),
        },
        h('span', null, wide ? text : text.slice(0, 2)),
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
          /* a missing stylesheet leaves an unstyled but working capsule */
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
      },
    };
  },
});
