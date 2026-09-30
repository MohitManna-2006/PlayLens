/**
 * Forecast review helpers. The origin is pinned; the observed future is read
 * from tracking separately and never feeds the model input (§7).
 */
import type { ModelInfo, TrajectoryPrediction } from "@/lib/contracts";
import type { Point } from "@/lib/tracking/geometry";
import { isPresent, type TrackingSeries } from "@/lib/tracking/series";

export function originProblem(series: TrackingSeries, index: number, model: ModelInfo | null): string | null {
  const t = model?.trajectory;
  if (!t) return "No trajectory model is served.";
  const need = t.input_window_frames;
  if (index < need - 1) return `The model needs ${need} observed frames up to the origin.`;
  for (let k = index - need + 1; k < index; k++) {
    if (series.gaps.some((g) => g.afterIndex === k)) return "The input window crosses a tracking gap.";
  }
  if (t.origin_after_snap && series.snapIndex !== null && index < series.snapIndex) {
    return `Forecast origins start at the snap (frame ${series.frameIds[series.snapIndex]}).`;
  }
  return null;
}

export function inputWindow(series: TrackingSeries, index: number, model: ModelInfo | null): [number, number] | null {
  const need = model?.trajectory?.input_window_frames;
  if (!need || index - need + 1 < 0) return null;
  return [series.frameIds[index - need + 1], series.frameIds[index]];
}

export function observedFuture(series: TrackingSeries, playerIndex: number, originIndex: number, horizon: number): Point[] {
  const t = series.tracks[playerIndex];
  const end = series.times[originIndex] + horizon + 1e-6;
  const out: Point[] = [];
  for (let k = originIndex + 1; k < series.times.length && series.times[k] <= end; k++) {
    if (series.gaps.some((g) => g.afterIndex === k - 1)) break;
    if (!isPresent(t, k)) break;
    out.push({ x: t.x[k], y: t.y[k] });
  }
  return out;
}

/** Predicted position at a real frame time after the origin, or null outside the valid horizon. */
export function predictedAt(result: TrajectoryPrediction, playerId: string, originTime: number, t: number): Point | null {
  const p = result.players.find((x) => x.player_id === playerId);
  if (!p) return null;
  const k = Math.round((t - originTime) / result.step_s) - 1;
  if (k < 0 || k >= p.path.length || !p.valid[k]) return null;
  return p.path[k];
}

export function validHorizon(result: TrajectoryPrediction, playerId: string): number {
  const p = result.players.find((x) => x.player_id === playerId);
  if (!p) return 0;
  let n = 0;
  while (n < p.valid.length && p.valid[n]) n++;
  return n * result.step_s;
}
