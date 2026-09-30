/**
 * Compare time alignment (§8). Default: elapsed seconds from each play's snap.
 * If either snap is missing both plays switch to recording start, explicitly.
 * Phase alignment maps supplied event anchors piecewise-linearly and is only
 * offered when both plays have the same anchors; events are never invented.
 */
import type { EventKind, TrackingSeries } from "@/lib/tracking/series";

export type AlignMode = "snap" | "start" | "phase";

export interface Alignment {
  mode: AlignMode;
  requested: AlignMode;
  label: string;
  fallbackReason: string | null;
  domain: [number, number];
  /** Master time τ → each play's own timestamp (unclamped). */
  toLeft: (tau: number) => number;
  toRight: (tau: number) => number;
  fromLeft: (t: number) => number;
  fromRight: (t: number) => number;
  /** Real sample instants of both plays in τ, preserving native sampling. */
  stops: number[];
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

export function align(l: TrackingSeries, r: TrackingSeries, requested: AlignMode): Alignment {
  const lEnd = l.times[l.times.length - 1];
  const rEnd = r.times[r.times.length - 1];
  const bothSnaps = l.snapIndex !== null && r.snapIndex !== null;
  let mode: AlignMode = requested;
  let fallbackReason: string | null = null;
  if ((requested === "snap" || requested === "phase") && !bothSnaps) {
    mode = "start";
    const which = l.snapIndex === null && r.snapIndex === null ? "Both plays have" : l.snapIndex === null ? "The left play has" : "The right play has";
    fallbackReason = `${which} no snap event, so both plays are aligned from recording start.`;
  } else if (requested === "phase" && !phaseAvailable(l, r)) {
    mode = "snap";
    fallbackReason = "Phase alignment needs snap, throw, and arrival events in both plays; using snap-relative time.";
  }

  let toLeft: (t: number) => number;
  let toRight: (t: number) => number;
  let fromLeft: (t: number) => number;
  let fromRight: (t: number) => number;
  let label: string;

  if (mode === "start") {
    toLeft = (t) => l.times[0] + t;
    toRight = (t) => r.times[0] + t;
    fromLeft = (t) => t - l.times[0];
    fromRight = (t) => t - r.times[0];
    label = "From recording start";
  } else if (mode === "snap") {
    const ls = l.times[l.snapIndex!];
    const rs = r.times[r.snapIndex!];
    toLeft = (t) => ls + t;
    toRight = (t) => rs + t;
    fromLeft = (t) => t - ls;
    fromRight = (t) => t - rs;
    label = "Snap-relative";
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
  }

  const domain: [number, number] = [
    Math.min(fromLeft(l.times[0]), fromRight(r.times[0])),
    Math.max(fromLeft(lEnd), fromRight(rEnd)),
  ];
  const stops = [...l.times.map(fromLeft), ...r.times.map(fromRight)]
    .map((v) => Math.round(v * 1000) / 1000)
    .sort((a, b) => a - b)
    .filter((v, i, arr) => i === 0 || v !== arr[i - 1]);

  return { mode, requested, label, fallbackReason, domain, toLeft, toRight, fromLeft, fromRight, stops };
}
