import { openDay } from "../collect";
import { setupFixtureDay } from "../prototypes/fixtures";

/**
 * Prototype: `clockout design` runs the next review UI (home, day cards, setup) on the
 * synthetic fixture day, before it replaces the real one.
 */
export async function runDesign() {
  const fixture = await setupFixtureDay();
  const { stored } = await openDay(fixture.date, fixture.config, fixture.store, {
    ai: null,
    sources: fixture.sources,
    ctx: fixture.ctx,
  });
  const { runPrototype } = await import("../prototypes/run");
  await runPrototype(stored.day, fixture.config);
}
