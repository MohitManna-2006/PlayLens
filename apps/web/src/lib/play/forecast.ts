/**
 * Forecast review helpers. The origin is pinned; the observed future is read
 * from tracking separately and never feeds the model input (§7).
 */
import type { FuturePayload, ModelInfo, TrajectoryPrediction } from "@/lib/contracts";
import type { Point } from "@/lib/tracking/geometry";
import { isPresent, type TrackingSeries } from "@/lib/tracking/series";

/** True for models that forecast only from the end of the observed window (the real-data model). */
export function isFixedOrigin(model: ModelInfo | null): boolean {
  return model?.trajectory?.origin === "last_observed_frame";
}

/** Index the forecast runs from: the last observed frame for fixed-origin models, else the current frame. */
export function forecastOriginIndex(series: TrackingSeries, model: ModelInfo | null, frameIndex: number): number {
  return isFixedOrigin(model) ? series.times.length - 1 : frameIndex;
}

export function originProblem(series: TrackingSeries, index: number, model: ModelInfo | null): string | null {
  const t = model?.trajectory;
  if (!t) return "No trajectory model is served.";
  if (t.origin === "last_observed_frame") {
    return index === series.times.length - 1 ? null : `This model forecasts from the last observed frame (${series.frameIds[series.times.length - 1]}).`;
  }
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

export interface ActualComparison {
  ade: number;
  fde: number;
  players: number;
  points: number;
}

/**
 * Error of a forecast against the held-out actual future, computed in the
 * browser with the evaluation definitions: per-player mean Euclidean error over
 * steps that are valid and have an actual position, averaged over players; FDE
 * at each player's last such step. Steps are matched by future frame_id.
 */
export function compareToActual(result: TrajectoryPrediction, future: FuturePayload): ActualComparison | null {
  if (future.id !== result.play_id || future.origin_frame_id !== result.origin_frame_id) return null;
  const actual = new Map(future.trajectories.map((t) => [t.player_id, new Map(t.points.map((p) => [p.frame_id, p]))]));
  let adeSum = 0;
  let fdeSum = 0;
  let players = 0;
  let points = 0;
  for (const p of result.players) {
    const truth = actual.get(p.player_id);
    if (!truth) continue;
    let sum = 0;
    let n = 0;
    let last = 0;
    p.path.forEach((q, k) => {
      const a = truth.get(result.future_frame_ids[k]);
      if (!p.valid[k] || !a) return;
      last = Math.hypot(q.x - a.x, q.y - a.y);
      sum += last;
      n += 1;
    });
    if (n === 0) continue;
    adeSum += sum / n;
    fdeSum += last;
    players += 1;
    points += n;
  }
  return players ? { ade: adeSum / players, fde: fdeSum / players, players, points } : null;
}

export interface ForecastPath {
  playerIndex: number;
  origin: Point;
  path: Point[];
  valid: boolean[];
}

/**
 * Predicted paths to draw, each anchored at the player's tracked position at
 * the origin frame. Fixed-origin (real) models show every forecast player with
 * the selected one emphasized; pinned-origin models show only the selection.
 */
export function forecastPaths(
  series: TrackingSeries,
  result: TrajectoryPrediction,
  originIndex: number,
  selectedId: string | null,
  showAll: boolean,
): { primary: ForecastPath | null; others: ForecastPath[] } {
  const paths: ForecastPath[] = [];
  for (const p of result.players) {
    const j = series.tracks.findIndex((t) => t.ref.player_id === p.player_id);
    if (j < 0 || !p.path.length || !isPresent(series.tracks[j], originIndex)) continue;
    const t = series.tracks[j];
    paths.push({ playerIndex: j, origin: { x: t.x[originIndex], y: t.y[originIndex] }, path: p.path, valid: p.valid });
  }
  const primary = paths.find((p) => series.tracks[p.playerIndex].ref.player_id === selectedId) ?? null;
  return { primary, others: showAll ? paths.filter((p) => p !== primary) : [] };
}
