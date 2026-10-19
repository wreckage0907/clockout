import { openDay } from "../collect";
import { setupFixtureDay } from "../prototypes/fixtures";

/**
 * Prototype: `clockout design [home|today|sources|chat]` renders candidate UIs
 * on the synthetic fixture day. ←/→ or tab to flip between them.
 */
export async function runDesign(name?: string) {
  const fixture = await setupFixtureDay();
  const { stored } = await openDay(fixture.date, fixture.config, fixture.store, {
    ai: null,
    sources: fixture.sources,
    ctx: fixture.ctx,
  });
  const { runDesigns } = await import("../prototypes/run");
  await runDesigns(name, stored.day, fixture.config, fixture.date);
}
