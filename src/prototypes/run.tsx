import { render, useWindowSize } from "ink";
import type { Config } from "../config/schema";
import type { Day } from "../core/types";
import { MouseProvider } from "../tui/clickable";
import { MOUSE_OFF, MOUSE_ON, withMouse } from "../tui/mouse";
import { Clockout } from "./Clockout";

/** The prototype at the terminal's current size. */
function Screen({ day, config }: { day: Day; config: Config }) {
  const { columns, rows } = useWindowSize();
  return <Clockout day={day} config={config} width={columns} height={rows} />;
}

/** Runs the design prototype on a drafted day: full screen, clickable. */
export async function runPrototype(day: Day, config: Config) {
  const { stdin, mouse, stop } = withMouse(process.stdin);
  const off = () => process.stdout.write(MOUSE_OFF);
  process.stdout.write(MOUSE_ON);
  process.once("exit", off);
  const ui = render(
    <MouseProvider events={mouse}>
      <Screen day={day} config={config} />
    </MouseProvider>,
    { stdin, exitOnCtrlC: true, alternateScreen: true },
  );
  try {
    await ui.waitUntilExit();
  } finally {
    off();
    stop();
  }
}
