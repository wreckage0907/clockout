import { render } from "ink-testing-library";
import { describe, expect, it } from "vitest";
import { applyEdits } from "../../src/core/edits";
import { timesheetRows } from "../../src/core/timesheet";
import { App } from "../../src/tui/App";
import { config, fakeActions, fixtureDay } from "../helpers/fake-app";
import { fakeTarget } from "../helpers/fake-target";
import { FIXTURE_DATE } from "../helpers/fixture-day";

const tick = () => new Promise((r) => setTimeout(r, 30));
const CTRL_S = "\u0013";
const DOWN = "\u001b[B";

async function until(frame: () => string | undefined, text: string) {
  for (let i = 0; i < 80 && !(frame() ?? "").includes(text); i++) await tick();
}

/** The fixture day with its open meetings answered (skipped), so it can be sent. */
const answered = applyEdits(
  fixtureDay,
  ["b4", "b6", "b7"].map((id) => ({ op: "delete" as const, id })),
  config,
).day;

async function openDay(opts: Parameters<typeof fakeActions>[0]) {
  const fake = fakeActions(opts);
  const ui = render(
    <App
      initialDate={FIXTURE_DATE}
      today={FIXTURE_DATE}
      config={config}
      actions={fake.actions}
      width={120}
      height={48}
    />,
  );
  await until(ui.lastFrame, "of 8h");
  ui.stdin.write("\r");
  await until(ui.lastFrame, "Copy sheet");
  return { ui, ...fake };
}

describe("sending the day to the ERP", () => {
  it("isn't offered when no ERP is set up", async () => {
    const { ui } = await openDay({});
    expect(ui.lastFrame()).not.toContain("Send to ERP");
  });

  it("waits until the meetings are answered", async () => {
    const erp = fakeTarget();
    const { ui } = await openDay({ erp: { target: erp.target } });
    expect(ui.lastFrame()).toContain("Send to ERP");
    ui.stdin.write(CTRL_S);
    await until(ui.lastFrame, "Answer the 3 meetings first");
    expect(erp.calls).toEqual([]);
  });

  it("asks for an ERP task once, shows what will change, and sends on Enter", async () => {
    const erp = fakeTarget({
      tasks: [
        { id: "TASK-OPS", subject: "Ops and support", project: "Internal" },
        { id: "TASK-CLK", subject: "Clockout development", project: "Clockout" },
      ],
    });
    const { ui, calls } = await openDay({
      day: answered,
      erp: {
        target: erp.target,
        map: [
          { project: "acme/api", erp_task: "TASK-API", label: "API maintenance" },
          { project: "Meetings", erp_task: "TASK-MEET", label: "Internal meetings" },
        ],
      },
    });
    ui.stdin.write(CTRL_S);
    await until(ui.lastFrame, "Which ERP task is this?");
    expect(ui.lastFrame()).toContain("dev-example/clockout");
    await until(ui.lastFrame, "Clockout development");
    ui.stdin.write(DOWN);
    await tick();
    ui.stdin.write("\r");

    await until(ui.lastFrame, "Send to erp.example.com");
    expect(calls.mapped).toEqual([
      { project: "dev-example/clockout", erp_task: "TASK-CLK", label: "Clockout development" },
    ]);
    const frame = ui.lastFrame() ?? "";
    expect(frame).toContain("+ Add");
    expect(frame).toContain("to Clockout development:");
    expect(frame).toContain("to API maintenance:");

    const rows = timesheetRows(answered, config).length;
    ui.stdin.write("\r");
    await until(ui.lastFrame, "✓ Sent");
    expect(ui.lastFrame()).toContain(`✓ Sent ${rows} changes to erp.example.com`);
    expect(erp.entries).toHaveLength(rows);

    // Again: nothing to send.
    ui.stdin.write(CTRL_S);
    await until(ui.lastFrame, "is up to date");
    expect(ui.lastFrame()).toContain("= Already sent");
    ui.stdin.write("\u001b");
    for (let i = 0; i < 80 && (ui.lastFrame() ?? "").includes("is up to date"); i++) await tick();
    expect(ui.lastFrame()).not.toContain("is up to date");
    expect(erp.entries).toHaveLength(rows);
  });
});
