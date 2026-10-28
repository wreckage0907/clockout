import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { App } from "../../src/tui/App";
import { Clickable, MouseProvider, Overlay } from "../../src/tui/clickable";
import { MOUSE_OFF, MOUSE_ON, type MouseEvent, splitMouse, withMouse } from "../../src/tui/mouse";
import { config, fakeActions } from "../helpers/fake-app";
import { FIXTURE_DATE } from "../helpers/fixture-day";

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

function click(
  events: EventEmitter,
  at: { x: number; y: number },
  mods: { shift?: boolean; alt?: boolean } = {},
) {
  const e: MouseEvent = {
    ...at,
    kind: "press",
    button: "left",
    shift: mods.shift ?? false,
    alt: mods.alt ?? false,
  };
  events.emit("mouse", e);
}

describe("mouse input", () => {
  it("pulls SGR mouse reports out of the input and keeps keys", () => {
    const r = splitMouse("", "a\u001b[<0;10;5Mb\u001b[<0;10;5m\u001b[<64;3;4M");
    expect(r.rest).toBe("ab");
    expect(r.events).toEqual([
      { x: 9, y: 4, kind: "press", button: "left", shift: false, alt: false },
      { x: 9, y: 4, kind: "release", button: "left", shift: false, alt: false },
      { x: 2, y: 3, kind: "wheelUp", button: "none", shift: false, alt: false },
    ]);
  });

  it("asks the terminal for Shift-clicks while on and hands them back when off", () => {
    expect(MOUSE_ON).toContain("\u001b[>1s");
    expect(MOUSE_OFF).toContain("\u001b[>0s");
  });

  it("reads Shift and Alt from an SGR mouse report", () => {
    const r = splitMouse("", "\u001b[<4;10;5M\u001b[<8;10;5M");
    expect(r.events).toEqual([
      { x: 9, y: 4, kind: "press", button: "left", shift: true, alt: false },
      { x: 9, y: 4, kind: "press", button: "left", shift: false, alt: true },
    ]);
  });

  it("holds a report split across chunks, wherever the split falls", () => {
    for (const [a, b] of [
      ["x\u001b[<0;1", ";2M"],
      ["x\u001b[", "<0;1;2M"],
      ["x\u001b", "[<0;1;2M"],
    ] as const) {
      const first = splitMouse("", a);
      expect(first.rest).toBe("x");
      const second = splitMouse(first.pending, b);
      expect(second).toMatchObject({ rest: "", pending: "" });
      expect(second.events).toEqual([
        { x: 0, y: 1, kind: "press", button: "left", shift: false, alt: false },
      ]);
    }
  });

  it("a held Escape still reaches the app when nothing follows it", async () => {
    const input = new PassThrough();
    const { stdin, stop } = withMouse(input as unknown as NodeJS.ReadStream);
    const got: string[] = [];
    stdin.on("data", (d: Buffer) => got.push(d.toString()));
    input.write("\u001b");
    await tick();
    stop();
    expect(got.join("")).toBe("\u001b");
  });

  it("a box that gets an onClick after mounting becomes clickable", async () => {
    const events = new EventEmitter();
    const hits: string[] = [];
    const view = (on: boolean) => (
      <MouseProvider events={events}>
        <Clickable onClick={on ? () => hits.push("hit") : undefined}>
          <Text>target</Text>
        </Clickable>
      </MouseProvider>
    );
    const { lastFrame, rerender } = render(view(false));
    await tick();
    click(events, find(lastFrame() ?? "", "target"));
    rerender(view(true));
    await tick();
    click(events, find(lastFrame() ?? "", "target"));
    expect(hits).toEqual(["hit"]);
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
    const events = new EventEmitter();
    const { lastFrame } = render(
      <MouseProvider events={events}>
        <App
          initialDate={FIXTURE_DATE}
          today={FIXTURE_DATE}
          config={config}
          actions={fakeActions().actions}
          width={120}
          height={40}
        />
      </MouseProvider>,
    );
    await until(lastFrame, "6h of 8h");
    click(events, find(lastFrame() ?? "", "Setup"));
    await until(lastFrame, "What Clockout reads");
    expect(lastFrame()).toContain("What Clockout reads");
    click(events, find(lastFrame() ?? "", "Claude Code"));
    await until(lastFrame, "Search Claude Code projects");
    expect(lastFrame()).toContain("Search Claude Code projects");
    expect(lastFrame()).toContain("acme-api");
  });

  it("clicks: a card's ✕ removes it from the day", async () => {
    const events = new EventEmitter();
    const { actions, calls } = fakeActions();
    const { lastFrame, stdin } = render(
      <MouseProvider events={events}>
        <App
          initialDate={FIXTURE_DATE}
          today={FIXTURE_DATE}
          config={config}
          actions={actions}
          width={120}
          height={40}
        />
      </MouseProvider>,
    );
    await until(lastFrame, "6h of 8h");
    stdin.write("\r");
    await until(lastFrame, "Copy sheet");
    click(events, find(lastFrame() ?? "", "✕")); // the first card: Daily standup
    await until(lastFrame, "5h 30m of 8h");
    expect(calls.commits.at(-1)?.ops).toEqual([{ op: "delete", id: "b1" }]);
  });

  it("checks a range with Shift-click, copies it, and removes it together", async () => {
    const events = new EventEmitter();
    const { actions, calls } = fakeActions();
    const { lastFrame, stdin } = render(
      <MouseProvider events={events}>
        <App
          initialDate={FIXTURE_DATE}
          today={FIXTURE_DATE}
          config={config}
          actions={actions}
          width={120}
          height={40}
        />
      </MouseProvider>,
    );
    await until(lastFrame, "6h of 8h");
    stdin.write("\r");
    await until(lastFrame, "Copy sheet");
    click(events, find(lastFrame() ?? "", "[ ]")); // Daily standup; anchors the range
    await until(lastFrame, "1 selected");
    click(events, find(lastFrame() ?? "", "Fix auth token refresh"), { shift: true });
    await until(lastFrame, "2 selected");
    expect(lastFrame()).toContain("2h 45m · shift- or option-click for a range");

    click(events, find(lastFrame() ?? "", " Copy "));
    await until(lastFrame, "Copied 2 selected rows");
    const lines = calls.copied[0]?.split("\n") ?? [];
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("Daily standup");
    expect(lines[1]).toContain("Fix auth token refresh");

    click(events, find(lastFrame() ?? "", " Remove "));
    await until(lastFrame, "3h 15m of 8h");
    expect(calls.commits.at(-1)?.ops).toEqual([
      { op: "delete", id: "b1" },
      { op: "delete", id: "b2" },
    ]);
  });

  it("ticks a card on Shift-click with nothing ticked, then extends from it", async () => {
    const events = new EventEmitter();
    const { actions } = fakeActions();
    const { lastFrame, stdin } = render(
      <MouseProvider events={events}>
        <App
          initialDate={FIXTURE_DATE}
          today={FIXTURE_DATE}
          config={config}
          actions={actions}
          width={120}
          height={40}
        />
      </MouseProvider>,
    );
    await until(lastFrame, "6h of 8h");
    stdin.write("\r");
    await until(lastFrame, "Copy sheet");
    click(events, find(lastFrame() ?? "", "Fix auth token refresh"), { shift: true });
    await until(lastFrame, "1 selected");
    expect(lastFrame()).toContain("[x] Fix auth token refresh");
    expect(lastFrame()).toContain("[ ] Daily standup");
    click(events, find(lastFrame() ?? "", "Daily standup"), { shift: true });
    await until(lastFrame, "2 selected");
    expect(lastFrame()).toContain("[x] Daily standup");
  });

  it("does the same on Option-click, which multiplexers like herdr pass through", async () => {
    const events = new EventEmitter();
    const { actions } = fakeActions();
    const { lastFrame, stdin } = render(
      <MouseProvider events={events}>
        <App
          initialDate={FIXTURE_DATE}
          today={FIXTURE_DATE}
          config={config}
          actions={actions}
          width={120}
          height={40}
        />
      </MouseProvider>,
    );
    await until(lastFrame, "6h of 8h");
    stdin.write("\r");
    await until(lastFrame, "Copy sheet");
    click(events, find(lastFrame() ?? "", "Fix auth token refresh"), { alt: true });
    await until(lastFrame, "1 selected");
    expect(lastFrame()).toContain("[x] Fix auth token refresh");
    expect(lastFrame()).toContain("[ ] Daily standup");
    click(events, find(lastFrame() ?? "", "Daily standup"), { alt: true });
    await until(lastFrame, "2 selected");
    expect(lastFrame()).toContain("[x] Daily standup");
  });

  it("clicks: a connected timesheet system lists its tasks and forgets one", async () => {
    const events = new EventEmitter();
    const withErp = {
      ...config,
      timesheet: {
        type: "http" as const,
        url: "https://erp.example.com",
        map: [{ project: "acme/api", erp_task: "TASK-1", label: "Acme API build" }],
      },
    };
    const { actions, calls } = fakeActions({
      setup: { config: withErp, erp: { connected: true } },
    });
    const { lastFrame } = render(
      <MouseProvider events={events}>
        <App
          initialDate={FIXTURE_DATE}
          today={FIXTURE_DATE}
          config={withErp}
          actions={actions}
          width={120}
          height={40}
        />
      </MouseProvider>,
    );
    await until(lastFrame, "6h of 8h");
    click(events, find(lastFrame() ?? "", "Setup"));
    await until(lastFrame, "What Clockout reads");
    click(events, find(lastFrame() ?? "", " ERP "));
    await until(lastFrame, "Acme API build");
    expect(lastFrame()).toContain("acme/api · every task → Acme API build");
    click(events, find(lastFrame() ?? "", "✕ forget"));
    await until(lastFrame, "No tasks picked yet");
    expect(calls.saved.at(-1)).toMatchObject({ timesheet: { map: [] } });
  });

  it("clicks: the date opens the picker, and Yesterday switches the day", async () => {
    const events = new EventEmitter();
    const { lastFrame } = render(
      <MouseProvider events={events}>
        <App
          initialDate={FIXTURE_DATE}
          today={FIXTURE_DATE}
          config={config}
          actions={fakeActions().actions}
          width={120}
          height={40}
        />
      </MouseProvider>,
    );
    await until(lastFrame, "6h of 8h");
    click(events, find(lastFrame() ?? "", "Fri, Oct 16 ▾"));
    await until(lastFrame, "Oct 2026");
    expect(lastFrame()).toContain("Oct 2026");
    click(events, find(lastFrame() ?? "", "Yesterday"));
    await until(lastFrame, "Yesterday · Thu, Oct 15");
    expect(lastFrame()).toContain("Yesterday · Thu, Oct 15");
  });
  it("ctrl+p doesn't open setup on top of the date picker", async () => {
    const events = new EventEmitter();
    const { lastFrame, stdin } = render(
      <MouseProvider events={events}>
        <App
          initialDate={FIXTURE_DATE}
          today={FIXTURE_DATE}
          config={config}
          actions={fakeActions().actions}
          width={120}
          height={40}
        />
      </MouseProvider>,
    );
    await until(lastFrame, "6h of 8h");
    click(events, find(lastFrame() ?? "", "Fri, Oct 16 ▾"));
    await until(lastFrame, "Oct 2026");
    stdin.write("\u0010"); // ctrl+p
    await tick();
    expect(lastFrame()).not.toContain("What Clockout reads");
    stdin.write("\u001b"); // esc closes the picker…
    await until(lastFrame, "Setup");
    stdin.write("\u0010"); // …and now ctrl+p opens setup
    await until(lastFrame, "What Clockout reads");
    expect(lastFrame()).toContain("What Clockout reads");
  });
});
