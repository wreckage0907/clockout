import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { buildDay } from "../../src/core/blocks";
import type { Day } from "../../src/core/types";
import { Chat } from "../../src/prototypes/Chat";
import { Designs } from "../../src/prototypes/Designs";
import { Home } from "../../src/prototypes/Home";
import { Review } from "../../src/prototypes/Review";
import { Sources } from "../../src/prototypes/Sources";
import { FIXTURE_DATE, fixtureActivities, fixtureConfig } from "../helpers/fixture-day";

const config = fixtureConfig();
const activities = await fixtureActivities();
const day: Day = buildDay(FIXTURE_DATE, activities, config);
const W = 110;
const H = 30;

describe("design prototypes", () => {
  it("home shows the wordmark and one input, nothing else", () => {
    const { lastFrame } = render(<Home width={W} height={H} date={FIXTURE_DATE} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("clockout");
    expect(frame).toContain("Say it, or / for commands");
    expect(frame).not.toContain("Ctrl+");
    expect(frame).not.toContain("today  sources");
  });

  it("typing / opens the command menu", async () => {
    const { lastFrame, stdin } = render(<Home width={W} height={H} date={FIXTURE_DATE} />);
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("/");
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain("pick a day");
    expect(lastFrame()).toContain("connect a source");
  });

  it("sources lists connectable cards", () => {
    const { lastFrame } = render(<Sources width={W} height={H} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Google Calendar");
    expect(frame).toContain("Claude Code");
    expect(frame).toContain("connect");
  });

  it("review shows blocks and hours without the ascii timeline", async () => {
    const { lastFrame } = render(<Review day={day} config={config} width={W} height={H} />);
    await new Promise((r) => setTimeout(r, 20));
    const frame = lastFrame() ?? "";
    expect(frame).toContain("gap · what filled it?");
    expect(frame).toContain("0h30");
    expect(frame).not.toContain("Ctrl+");
    expect(frame).not.toContain("░░░");
  });

  it("chat renders the timesheet as a message card", () => {
    const { lastFrame } = render(<Chat day={day} config={config} width={W} height={H} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("clockout ·");
    expect(frame).toContain("questions");
  });

  it("wrapper flips sections with tab", async () => {
    const { lastFrame, stdin } = render(
      <Designs day={day} config={config} date={FIXTURE_DATE} initial="home" />,
    );
    await new Promise((r) => setTimeout(r, 20));
    stdin.write("\t");
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain("gap · what filled it?");
    stdin.write("\u001b[Z"); // shift+tab
    await new Promise((r) => setTimeout(r, 20));
    expect(lastFrame()).toContain("Say it, or / for commands");
  });
});
