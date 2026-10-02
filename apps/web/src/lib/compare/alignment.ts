/**
 * Compare time alignment (§8). The two plays usually have different lengths, so
 * "synced" needs a definition. Modes:
 *
 * - progress (default): normalized progress p ∈ [0, 1] from each play's first
 *   observed frame (0) to its last observed frame (1). When paused or stepped,
 *   each play shows its real frame round(p × (frames − 1)); during playback the
 *   renderer interpolates as everywhere else. The longer play runs at real speed,
 *   the shorter one slower.
 * - origin: real seconds relative to each play's last observed frame (where the
 *   dataset's input window ends and the trajectory model forecasts from). Both
 *   plays reach that frame together and play at real speed.
 * - start: real seconds from each play's first observed frame.
 * - snap / phase: snap-relative time and piecewise-linear event anchors, offered
 *   only when both plays carry those events (the real dataset has none). Events
 *   are never invented.
 */
import type { EventKind, TrackingSeries } from "@/lib/tracking/series";

export type AlignMode = "progress" | "origin" | "start" | "snap" | "phase";

export const ALIGN_MODES: AlignMode[] = ["progress", "origin", "start", "snap", "phase"];
export const DEFAULT_ALIGN: AlignMode = "progress";

export interface Alignment {
  mode: AlignMode;
  requested: AlignMode;
  label: string;
  /** What "synced" means in this mode, in one sentence. */
  description: string;
  fallbackReason: string | null;
  domain: [number, number];
  /** Where a fresh comparison starts. */
  initial: number;
  /** Master time τ → each play's own timestamp (unclamped, continuous). */
  toLeft: (tau: number) => number;
  toRight: (tau: number) => number;
  /** Master time τ → the timestamp of the real frame each play shows when paused. */
  frameLeft: (tau: number) => number;
  frameRight: (tau: number) => number;
  fromLeft: (t: number) => number;
  fromRight: (t: number) => number;
  /** Real sample instants of both plays in τ, preserving native sampling. */
  stops: number[];
  /** τ → progress label, for modes whose master time is not seconds. */
  progressAt: ((tau: number) => number) | null;
}

const ANCHOR_KINDS: EventKind[] = ["snap", "throw", "arrival"];

function anchors(s: TrackingSeries): number[] | null {
  const out: number[] = [];
  for (const k of ANCHOR_KINDS) {
    const e = s.events.find((ev) => ev.kind === k || (k === "arrival" && ev.kind === "catch"));
    if (!e) return null;
    out.push(e.time);
  }
  return out.every((v, i) => i === 0 || v > out[i - 1]) ? out : null;
}

export function phaseAvailable(l: TrackingSeries, r: TrackingSeries): boolean {
  return !!anchors(l) && !!anchors(r);
}

export function snapAvailable(l: TrackingSeries, r: TrackingSeries): boolean {
  return l.snapIndex !== null && r.snapIndex !== null;
}

/** The frame a play shows at normalized progress p: round(p × (frames − 1)). */
export function progressIndex(frameCount: number, p: number): number {
  if (frameCount <= 1) return 0;
  const clamped = Math.min(1, Math.max(0, p));
  return Math.round(clamped * (frameCount - 1));
}

function piecewise(xs: number[], ys: number[]) {
  return (x: number) => {
    if (x <= xs[0]) return ys[0] + (x - xs[0]);
    for (let i = 1; i < xs.length; i++) {
      if (x <= xs[i]) {
        const f = (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
        return ys[i - 1] + f * (ys[i] - ys[i - 1]);
      }
    }
    return ys[ys.length - 1] + (x - xs[xs.length - 1]);
  };
}

const first = (s: TrackingSeries) => s.times[0];
const last = (s: TrackingSeries) => s.times[s.times.length - 1];

export function align(l: TrackingSeries, r: TrackingSeries, requested: AlignMode): Alignment {
  let mode: AlignMode = requested;
  let fallbackReason: string | null = null;
  if ((requested === "snap" || requested === "phase") && !snapAvailable(l, r)) {
    mode = DEFAULT_ALIGN;
    const which =
      l.snapIndex === null && r.snapIndex === null ? "Neither play has" : l.snapIndex === null ? "The left play has" : "The right play has";
    fallbackReason = `${which} a snap event, so both plays are synced by normalized progress.`;
  } else if (requested === "phase" && !phaseAvailable(l, r)) {
    mode = "snap";
    fallbackReason = "Phase alignment needs snap, throw, and arrival events in both plays; using snap-relative time.";
  }

  let toLeft: (t: number) => number;
  let toRight: (t: number) => number;
  let fromLeft: (t: number) => number;
  let fromRight: (t: number) => number;
  let frameLeft: ((t: number) => number) | null = null;
  let frameRight: ((t: number) => number) | null = null;
  let progressAt: ((t: number) => number) | null = null;
  let label: string;
  let description: string;
  let initial = 0;

  if (mode === "progress") {
    const lDur = last(l) - first(l);
    const rDur = last(r) - first(r);
    // Master time runs in seconds of the longer play, so 1× is real speed for it.
    const span = Math.max(lDur, rDur, 1e-6);
    const p = (tau: number) => tau / span;
    toLeft = (tau) => first(l) + p(tau) * lDur;
    toRight = (tau) => first(r) + p(tau) * rDur;
    fromLeft = (t) => (lDur > 0 ? ((t - first(l)) / lDur) * span : 0);
    fromRight = (t) => (rDur > 0 ? ((t - first(r)) / rDur) * span : 0);
    frameLeft = (tau) => l.times[progressIndex(l.times.length, p(tau))];
    frameRight = (tau) => r.times[progressIndex(r.times.length, p(tau))];
    progressAt = p;
    label = "Normalized progress";
    description =
      "Both plays run from their first observed frame (0%) to their last observed frame (100%) together; the shorter play is slowed down. Paused, each shows frame round(progress × (frames − 1)).";
  } else if (mode === "origin") {
    toLeft = (t) => last(l) + t;
    toRight = (t) => last(r) + t;
    fromLeft = (t) => t - last(l);
    fromRight = (t) => t - last(r);
    label = "Last observed frame";
    description =
      "Real seconds relative to each play's last observed frame (where the input window ends and the model forecasts from). Both plays reach it together at real speed.";
    initial = Math.min(first(l) - last(l), first(r) - last(r));
  } else if (mode === "start") {
    toLeft = (t) => first(l) + t;
    toRight = (t) => first(r) + t;
    fromLeft = (t) => t - first(l);
    fromRight = (t) => t - first(r);
    label = "From recording start";
    description = "Real seconds from each play's first observed frame; both play at real speed.";
  } else if (mode === "snap") {
    const ls = l.times[l.snapIndex!];
    const rs = r.times[r.snapIndex!];
    toLeft = (t) => ls + t;
    toRight = (t) => rs + t;
    fromLeft = (t) => t - ls;
    fromRight = (t) => t - rs;
    label = "Snap-relative";
    description = "Real seconds from each play's snap event.";
  } else {
    const la = anchors(l)!;
    const ra = anchors(r)!;
    const ls = la[0];
    const lToR = piecewise(la, ra);
    const rToL = piecewise(ra, la);
    toLeft = (t) => ls + t;
    toRight = (t) => lToR(ls + t);
    fromLeft = (t) => t - ls;
    fromRight = (t) => rToL(t) - ls;
    label = "Phase aligned · playback speeds differ";
    description = "Snap, throw, and arrival are mapped onto each other; time between them is stretched linearly.";
  }

  const domain: [number, number] = [
    Math.min(fromLeft(first(l)), fromRight(first(r))),
    Math.max(fromLeft(last(l)), fromRight(last(r))),
  ];
  if (mode !== "origin") initial = Math.max(domain[0], Math.min(0, domain[1]));
  const stops = [...l.times.map(fromLeft), ...r.times.map(fromRight)]
    .map((v) => Math.round(v * 1000) / 1000)
    .sort((a, b) => a - b)
    .filter((v, i, arr) => i === 0 || v !== arr[i - 1]);

  return {
    mode,
    requested,
    label,
    description,
    fallbackReason,
    domain,
    initial,
    toLeft,
    toRight,
    frameLeft: frameLeft ?? toLeft,
    frameRight: frameRight ?? toRight,
    fromLeft,
    fromRight,
    stops,
    progressAt,
  };
}
