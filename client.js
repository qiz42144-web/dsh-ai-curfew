/**
 * Client half of dsh-ai-curfew.
 *
 * P0 scaffold: proves the `dsh.client` bundle is served under /plugins and
 * materialized by the page. The status capsule and the 24-hour schedule band
 * arrive in P5, which is why nothing is registered yet.
 *
 * Hand-written plugin: no build step, no JSX, no bare imports. `react` is the
 * only module this factory may require.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ai-curfew',
  factory() {
    return {
      inject: [],
      apply() {
        console.log('[ai-curfew] client half loaded');
      },
    };
  },
});
