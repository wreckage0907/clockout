// Design tokens. One dark palette in the opencode family (near-black canvas, panels a step
// lighter, a thick left bar marking focus), with Clockout's own accent: mint for "done".
// Kept as plain values so a desktop port can turn them into CSS variables one to one.

export const T = {
  /** Screen canvas. */
  bg: "#0b0b0d",
  /** Sidebar, dialogs. */
  panel: "#141417",
  /** Input box, the selected row. */
  element: "#1d1d22",
  /** Chips and hover inside an element. */
  elementHi: "#2a2a31",
  border: "#3a3a42",

  text: "#ececef",
  muted: "#8b8b94",
  faint: "#56565e",

  /** Brand and "ready": the input bar, progress, the selected command. */
  primary: "#6ee7b7",
  /** Text on a primary background. */
  onPrimary: "#0b0b0d",
  /** Anything that needs an answer from you. */
  ask: "#f5b14c",
  meeting: "#a78bfa",
  danger: "#f2777a",
  info: "#6aa6ff",
} as const;

/** Project colours, picked by name so a project keeps its colour across days. */
const PROJECT_COLORS = ["#6aa6ff", "#e879a6", "#5fd4c4", "#a3d977", "#ff8a80", "#7dd3fc"];

export function projectColor(project: string): string {
  if (project === "Meetings") return T.meeting;
  if (project === "Break") return T.faint;
  let h = 0;
  for (const ch of project) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PROJECT_COLORS[h % PROJECT_COLORS.length] ?? T.info;
}

/** "2h 15m", "45m", "3h". The one way the screens write a duration. */
export function hm(minutes: number): string {
  const m = Math.round(minutes);
  const h = Math.floor(m / 60);
  const r = m % 60;
  if (h === 0) return `${r}m`;
  return r === 0 ? `${h}h` : `${h}h ${r}m`;
}
