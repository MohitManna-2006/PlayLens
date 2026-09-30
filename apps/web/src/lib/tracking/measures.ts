/**
 * Deterministic measures computed from tracking frames. Each function has a
 * written definition exported alongside it so the UI can show exactly what a
 * number means (§13, §15 provenance).
 */
import { velocityFromAngle, type Point } from "./geometry";
import { isPresent, type TrackingSeries } from "./series";

export const DEFINITIONS = {
  separation:
    "Euclidean distance from the selected player to the nearest tracked opponent at the current frame, in yards.",
  relativeSpeed:
    "Magnitude of the selected player's velocity minus the nearest opponent's velocity at the current frame (from tracked speed and direction), in yd/s.",
  forecastError:
    "Distance between the predicted position and the observed position at the current frame, for frames after the pinned forecast origin, in yards.",
  interactionGraph:
    "Display graph: each player connects to its 3 nearest tracked players at the current frame. Computed in the browser; not model attention.",
  nearestOpponent: "Nearest tracked opponent at the current frame by Euclidean distance.",
  trail: "Observed positions over the previous 1.0 s, bounded by valid frames.",
} as const;

export function positionAt(series: TrackingSeries, playerIndex: number, i: number): Point | null {
  const t = series.tracks[playerIndex];
  if (!t || !isPresent(t, i)) return null;
  return { x: t.x[i], y: t.y[i] };
}

export interface NearestOpponent {
  playerIndex: number;
  distance: number;
}

export function nearestOpponent(series: TrackingSeries, playerIndex: number, i: number): NearestOpponent | null {
  const self = series.tracks[playerIndex];
  if (!self || !isPresent(self, i)) return null;
  let best: NearestOpponent | null = null;
  series.tracks.forEach((t, j) => {
    if (j === playerIndex || t.ref.side === self.ref.side || !isPresent(t, i)) return;
    const d = Math.hypot(t.x[i] - self.x[i], t.y[i] - self.y[i]);
    if (!best || d < best.distance) best = { playerIndex: j, distance: d };
  });
  return best;
}

export function separationSeries(series: TrackingSeries, playerIndex: number): Array<number | null> {
  return series.times.map((_, i) => nearestOpponent(series, playerIndex, i)?.distance ?? null);
}

export function velocityAt(series: TrackingSeries, playerIndex: number, i: number): Point | null {
  const t = series.tracks[playerIndex];
  if (!t || !isPresent(t, i)) return null;
  const s = t.s[i];
  const dir = t.dir[i];
  if (!Number.isFinite(s) || !Number.isFinite(dir)) return null;
  return velocityFromAngle(s, dir);
}

export function relativeSpeed(series: TrackingSeries, a: number, b: number, i: number): number | null {
  const va = velocityAt(series, a, i);
  const vb = velocityAt(series, b, i);
  if (!va || !vb) return null;
  return Math.hypot(va.x - vb.x, va.y - vb.y);
}

export interface Edge {
  a: number;
  b: number;
}

/** Undirected k-nearest-neighbour display graph at frame i. */
export function knnGraph(series: TrackingSeries, i: number, k = 3): Edge[] {
  const present = series.tracks.map((t, j) => (isPresent(t, i) ? j : -1)).filter((j) => j >= 0);
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const j of present) {
    const tj = series.tracks[j];
    const nearest = present
      .filter((m) => m !== j)
      .map((m) => ({ m, d: Math.hypot(series.tracks[m].x[i] - tj.x[i], series.tracks[m].y[i] - tj.y[i]) }))
      .sort((p, q) => p.d - q.d)
      .slice(0, k);
    for (const { m } of nearest) {
      const key = j < m ? `${j}-${m}` : `${m}-${j}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ a: Math.min(j, m), b: Math.max(j, m) });
    }
  }
  return edges;
}

/** Indices for a trail ending at frame i: previous `seconds`, stopping at gaps or absence. */
export function trailRange(series: TrackingSeries, playerIndex: number, i: number, seconds = 1): [number, number] | null {
  const t = series.tracks[playerIndex];
  if (!t || !isPresent(t, i)) return null;
  const tStart = series.times[i] - seconds - 1e-6;
  let start = i;
  while (start > 0) {
    const prev = start - 1;
    if (series.times[prev] < tStart) break;
    if (!isPresent(t, prev)) break;
    if (series.gaps.some((g) => g.afterIndex === prev)) break;
    start = prev;
  }
  return start < i ? [start, i] : null;
}

/** Summary used by the Analyst tool layer. */
export function separationExtremes(values: Array<number | null>, from = 0): { min: { index: number; value: number } | null; max: { index: number; value: number } | null } {
  let min: { index: number; value: number } | null = null;
  let max: { index: number; value: number } | null = null;
  for (let i = from; i < values.length; i++) {
    const v = values[i];
    if (v === null) continue;
    if (!min || v < min.value) min = { index: i, value: v };
    if (!max || v > max.value) max = { index: i, value: v };
  }
  return { min, max };
}
