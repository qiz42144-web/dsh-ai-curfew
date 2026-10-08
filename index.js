/**
 * Host half of dsh-ai-curfew.
 *
 * P0 scaffold: proves the plugin loads inside the Host tree and that the
 * context API we intend to use is available. The duty-cycle gates arrive in P1+.
 */

export const name = 'ai-curfew';

/** No hard dependencies: every service this plugin wants is resolved with `ctx.get()` behind a guard. */
export const inject = [];

export function apply(ctx) {
  console.log('[ai-curfew] host half loaded');

  // Exercise the disposal path now, so P1 can register listeners without
  // wondering whether `ctx.effect` behaves as expected in this runtime.
  ctx.effect(() => () => {
    console.log('[ai-curfew] host half disposed');
  });
}
