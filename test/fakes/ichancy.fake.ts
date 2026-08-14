/**
 * The Ichancy fake, re-exported for e2e use.
 *
 * WHY a re-export instead of a second fake: `FakeIchancyAdapter` is the same object the application
 * runs against under `ICHANCY_FAKE=1`, and it implements `IchancyPort` — the identical interface the
 * HTTP adapter implements. A test-owned duplicate would be free to be wrong in ways the real
 * adapter is not, and the behaviours that actually matter here are the awkward ones the real API
 * has: `registerPlayer` answering `1` instead of an id, a credit that returns `[]`, a timeout that
 * is genuinely ambiguous. Those are already modelled.
 *
 * Typical use inside a suite that built its app with `createTestApp()`:
 *
 *   const ichancy = ctx.app.get(FakeIchancyAdapter);
 *   ichancy.seedPlayer({ ... });
 *   ichancy.setMode('agent-float-empty');          // next credit is rejected
 *   ichancy.script({ mode: 'ambiguous', times: 1 }); // one timeout, then normal service
 *
 * The `ambiguous` mode is the one worth writing tests around: it is what forces the credit worker
 * down the BALANCE_DELTA path, which is the only thing standing between "the network blinked" and
 * "we credited the player twice".
 */
export {
  FakeIchancyAdapter,
  type FakeIchancyBehaviour,
  type FakeIchancyMode,
} from '@core/ichancy/fake-ichancy.adapter';

export { ICHANCY_PORT, type IchancyPort } from '@core/ichancy/ichancy.port';

export {
  isIchancyOk,
  isIchancyRejected,
  isIchancyAmbiguous,
  IchancyRejectionCodes,
  type IchancyResult,
} from '@core/ichancy/ichancy.types';
