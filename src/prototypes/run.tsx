import { render } from "ink";
import type { Config } from "../config/schema";
import type { Day } from "../core/types";
import { Designs } from "./Designs";

/** Runs the UI design prototypes on a drafted day. Flip designs with ←/→ or tab. */
export function runDesigns(initial: string | undefined, day: Day, config: Config, date: string) {
  const ui = render(<Designs day={day} config={config} date={date} initial={initial} />, {
    exitOnCtrlC: true,
  });
  return ui.waitUntilExit();
}
