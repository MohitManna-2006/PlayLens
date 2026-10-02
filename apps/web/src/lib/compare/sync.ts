/**
 * Compare playback state: one master clock while synced, two independent clocks
 * when sync is off. Pure helpers so the behaviour is testable without React.
 */
import { Clock } from "@/lib/replay/clock";
import { frameIndexAt, type TrackingSeries } from "@/lib/tracking/series";
import type { Alignment } from "./alignment";

export type Side = "left" | "right";

export function clampTime(series: TrackingSeries, t: number): number {
  return Math.min(series.times[series.times.length - 1], Math.max(series.times[0], t));
}

/**
 * A play's own timestamp at master time τ. Playing: continuous (the renderer
 * interpolates for smooth motion). Paused or scrubbed: the real frame the
 * alignment assigns, so inspection never shows an in-between position.
 */
export function sideTime(a: Alignment, series: TrackingSeries, side: Side, tau: number, playing: boolean): number {
  const t = playing ? (side === "left" ? a.toLeft(tau) : a.toRight(tau)) : side === "left" ? a.frameLeft(tau) : a.frameRight(tau);
  return clampTime(series, t);
}

export function sideFrameIndex(a: Alignment, series: TrackingSeries, side: Side, tau: number, playing: boolean): number {
  return frameIndexAt(series.times, sideTime(a, series, side, tau, playing));
}

/** True once master time has moved past this play's last observed frame. */
export function sideEnded(a: Alignment, series: TrackingSeries, side: Side, tau: number): boolean {
  const t = side === "left" ? a.toLeft(tau) : a.toRight(tau);
  return t > series.times[series.times.length - 1] + 1e-6;
}

export function masterClock(a: Alignment): Clock {
  return new Clock({ start: a.domain[0], end: a.domain[1], stops: a.stops, initial: a.initial });
}

export function playClock(series: TrackingSeries, t: number): Clock {
  return new Clock({
    start: series.times[0],
    end: series.times[series.times.length - 1],
    stops: series.times,
    gaps: series.gaps.map((g) => ({ from: g.startTime, to: g.endTime })),
    initial: clampTime(series, t),
  });
}

/** Sync off: pause the master and give each play its own clock at the frame it showed. */
export function unsync(master: Clock, a: Alignment, left: TrackingSeries, right: TrackingSeries): { left: Clock; right: Clock } {
  master.pause();
  const tau = master.getTime();
  return {
    left: playClock(left, sideTime(a, left, "left", tau, false)),
    right: playClock(right, sideTime(a, right, "right", tau, false)),
  };
}

/** Sync on again: the master resumes from the left play's position. */
export function resync(master: Clock, a: Alignment, locals: { left: Clock; right: Clock }): void {
  master.seek(a.fromLeft(locals.left.getTime()));
  locals.left.dispose();
  locals.right.dispose();
}
