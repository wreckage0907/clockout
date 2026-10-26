import { describe, expect, it } from "vitest";
import { summarizeDay } from "../../src/ai/summarize";
import type { CompleteRequest, LlmBackend } from "../../src/ai/types";
import { configSchema } from "../../src/config/schema";
import { buildDay } from "../../src/core/blocks";
import { atLocalTime, localTime } from "../../src/core/time";
import { timesheetRows } from "../../src/core/timesheet";
import type { Activity } from "../../src/core/types";
import { toCsv, toMarkdown } from "../../src/export/formats";

// A recorded meeting and the same event on the calendar are one meeting (ADR 0010): the
// calendar's title, the recording's times, and no question about whether you were there.

const TZ = "Asia/Kolkata";
const D = "2026-10-16";
const at = (hhmm: string) => atLocalTime(D, hhmm, TZ);

const config = configSchema.parse({
  me: { name: "Dev", emails: ["dev@example.com"], timezone: TZ },
  day: { working_hours: "09:30-18:30", idle_cutoff: "20m", round_to: "15m" },
});

function calendar(from: string, to: string, extra: Partial<Activity> = {}): Activity {
  return {
    source: "google-calendar",
    kind: "meeting",
    actor: "human",
    start: at(from),
    end: at(to),
    title: "Design review",
    attendance: "accepted",
    attendees: ["lead@example.com"],
    refs: ["event:evt-1"],
    ...extra,
  };
}

function recording(from: string, to: string, extra: Partial<Activity> = {}): Activity {
  return {
    source: "wispr-flow",
    kind: "meeting",
    actor: "human",
    start: at(from),
    end: at(to),
    title: "Design review (recording)",
    attendance: "accepted",
    recorded: true,
    refs: ["event:evt-1", "recording:rec-1"],
    notes: "Agreed on the new card layout.",
    ...extra,
  };
}

function prompt(hhmm: string): Activity {
  return {
    source: "claude-code",
    kind: "prompt",
    actor: "human",
    start: at(hhmm),
    repo: "acme/api",
    branch: "main",
    sessionId: "s1",
    title: "Layout work",
  };
}

const meetings = (acts: Activity[]) =>
  buildDay(D, acts, config).blocks.filter((b) => b.kind === "meeting");

describe("a meeting you recorded", () => {
  it("is one meeting with its calendar event, with the calendar's title and the recording's times", () => {
    const [m, ...rest] = meetings([
      // The calendar had it 09:00–09:45; the recording ran 09:00–09:52.
      calendar("09:00", "09:45"),
      recording("09:00", "09:52"),
    ]);
    expect(rest).toEqual([]);
    expect(m).toMatchObject({
      kind: "meeting",
      summary: "Design review",
      start: at("09:00"),
      end: at("09:52"),
      project: "Meetings",
      confirmed: true,
    });
    expect(localTime(m?.end ?? at("09:00"), TZ)).toBe("09:52");
    // What the recorder said is on the block, for the screen only.
    expect(m?.evidence[0]?.notes).toBe("Agreed on the new card layout.");
  });

  it("settles attendance, even when the calendar says you didn't reply", () => {
    const day = buildDay(
      D,
      [calendar("09:00", "09:45", { attendance: "needs_action" }), recording("09:00", "09:52")],
      config,
    );
    expect(day.questions.filter((q) => q.kind === "attendance")).toEqual([]);
    expect(day.blocks.filter((b) => b.kind === "meeting")[0]?.confirmed).toBe(true);
  });

  it("counts a meeting you declined, because you were recorded in it", () => {
    const day = buildDay(
      D,
      [calendar("09:00", "09:45", { attendance: "declined" }), recording("09:00", "09:52")],
      config,
    );
    expect(day.notes.filter((n) => n.includes("declined"))).toEqual([]);
    const rows = timesheetRows(day, config);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ project: "Meetings", hours: 0.75 });
  });

  it("stays a meeting of its own when no calendar has the event", () => {
    const [m, ...rest] = meetings([recording("09:00", "09:52", { refs: ["recording:rec-1"] })]);
    expect(rest).toEqual([]);
    expect(m?.summary).toBe("Design review (recording)");
    expect(m?.minutes).toBeUndefined();
  });

  it("isn't matched to a different event at the same time", () => {
    const other = calendar("09:00", "09:45", { refs: ["event:evt-2"], title: "Other meeting" });
    expect(
      meetings([other, recording("09:00", "09:52")])
        .map((b) => b.summary)
        .sort(),
    ).toEqual(["Design review (recording)", "Other meeting"]);
  });

  it("keeps a recording's length when it overlaps work", () => {
    const day = buildDay(D, [prompt("09:00"), recording("09:05", "09:52")], config);
    expect(day.blocks.find((b) => b.kind === "meeting")?.end).toEqual(at("09:52"));
    const work = day.blocks.find((b) => b.kind === "work");
    expect(work === undefined || work.end <= at("09:05")).toBe(true);
  });
});

describe("what a recorder said stays private", () => {
  it("is never asked of the AI helper", async () => {
    const day = buildDay(D, [recording("09:00", "09:52")], config);
    const prompts: string[] = [];
    const backend: LlmBackend = {
      id: "test",
      label: "test",
      async complete<T>(req: CompleteRequest<T>) {
        prompts.push(req.prompt);
        return req.schema.parse({ summaries: [] });
      },
    };
    await summarizeDay(day, backend, {});
    expect(prompts.join("\n")).not.toContain("Agreed on the new card layout");
  });

  it("is never exported", () => {
    const day = buildDay(D, [recording("09:00", "09:52")], config);
    const rows = timesheetRows(day, config);
    const said = `${toCsv(rows)}${toMarkdown(rows)}`;
    expect(said).not.toContain("Agreed on the new card layout");
    expect(said).toContain("Design review (recording)");
  });
});
