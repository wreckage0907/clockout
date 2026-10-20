import { EventEmitter } from "node:events";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { buildDay } from "../../src/core/blocks";
import { Clockout } from "../../src/prototypes/Clockout";
import { Clickable, MouseProvider, Overlay } from "../../src/tui/clickable";
import { type MouseEvent, splitMouse } from "../../src/tui/mouse";
import { FIXTURE_DATE, fixtureActivities, fixtureConfig } from "../helpers/fixture-day";

const tick = () => new Promise((r) => setTimeout(r, 30));

/** Waits until the screen shows `text`, then a moment more for click targets to register. */
async function until(frame: () => string | undefined, text: string) {
  for (let i = 0; i < 50 && !(frame() ?? "").includes(text); i++) await tick();
  await tick();
}

/** Column and row of the first occurrence of `text` in a frame. */
function find(frame: string, text: string): { x: number; y: number } {
  const lines = frame.split("\n");
  const y = lines.findIndex((l) => l.includes(text));
  if (y === -1) throw new Error(`"${text}" not on screen`);
  return { x: [...(lines[y] ?? "").slice(0, lines[y]?.indexOf(text))].length, y };
}

function click(events: EventEmitter, at: { x: number; y: number }) {
  const e: MouseEvent = { ...at, kind: "press", button: "left" };
  events.emit("mouse", e);
}

describe("mouse input", () => {
  it("pulls SGR mouse reports out of the input and keeps keys", () => {
    const r = splitMouse("", "a\u001b[<0;10;5Mb\u001b[<0;10;5m\u001b[<64;3;4M");
    expect(r.rest).toBe("ab");
    expect(r.events).toEqual([
      { x: 9, y: 4, kind: "press", button: "left" },
      { x: 9, y: 4, kind: "release", button: "left" },
      { x: 2, y: 3, kind: "wheelUp", button: "none" },
    ]);
  });

  it("holds a report split across chunks, but never a lone Escape", () => {
    const first = splitMouse("", "x\u001b[<0;1");
    expect(first).toMatchObject({ rest: "x", events: [], pending: "\u001b[<0;1" });
    const second = splitMouse(first.pending, ";2M");
    expect(second.events).toHaveLength(1);
    expect(splitMouse("", "\u001b").rest).toBe("\u001b");
  });

  it("clicks the innermost target, and an overlay swallows clicks under it", async () => {
    const events = new EventEmitter();
    const hits: string[] = [];
    const { lastFrame, rerender } = render(
      <MouseProvider events={events}>
        <Clickable onClick={() => hits.push("row")}>
          <Text>row </Text>
          <Clickable onClick={() => hits.push("chip")}>
            <Text>chip</Text>
          </Clickable>
        </Clickable>
      </MouseProvider>,
    );
    await tick();
    click(events, find(lastFrame() ?? "", "chip"));
    click(events, find(lastFrame() ?? "", "row"));
    expect(hits).toEqual(["chip", "row"]);

    rerender(
      <MouseProvider events={events}>
        <Clickable onClick={() => hits.push("row")}>
          <Text>row chip</Text>
        </Clickable>
        <Overlay onOutside={() => hits.push("closed")}>
          <Text>dialog</Text>
        </Overlay>
      </MouseProvider>,
    );
    await tick();
    click(events, find(lastFrame() ?? "", "row"));
    expect(hits).toEqual(["chip", "row", "closed"]);
  });

  it("clicks: Setup opens setup, Claude Code opens its project search", async () => {
    const config = fixtureConfig();
    const day = buildDay(FIXTURE_DATE, await fixtureActivities(), config);
    const events = new EventEmitter();
    const { lastFrame } = render(
      <MouseProvider events={events}>
        <Clockout day={day} config={config} width={120} height={40} />
      </MouseProvider>,
    );
    await tick();
    click(events, find(lastFrame() ?? "", "Setup"));
    await until(lastFrame, "Tick what Clockout reads");
    expect(lastFrame()).toContain("Tick what Clockout reads");
    click(events, find(lastFrame() ?? "", "Claude Code"));
    await until(lastFrame, "Search Claude Code projects");
    expect(lastFrame()).toContain("Search Claude Code projects");
    expect(lastFrame()).toContain("acme/api");
  });

  it("clicks: the date opens the picker, and Yesterday switches the day", async () => {
    const config = fixtureConfig();
    const day = buildDay(FIXTURE_DATE, await fixtureActivities(), config);
    const events = new EventEmitter();
    const { lastFrame } = render(
      <MouseProvider events={events}>
        <Clockout day={day} config={config} width={120} height={40} />
      </MouseProvider>,
    );
    await tick();
    click(events, find(lastFrame() ?? "", "Fri, Oct 16 ▾"));
    await until(lastFrame, "Oct 2026");
    expect(lastFrame()).toContain("Oct 2026");
    click(events, find(lastFrame() ?? "", "Yesterday"));
    await until(lastFrame, "Nothing logged yet");
    expect(lastFrame()).toContain("Yesterday · Thu, Oct 15");
    expect(lastFrame()).toContain("Nothing logged yet");
  });
});
