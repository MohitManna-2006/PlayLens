/**
 * Ground truth after the observed window, for display only (Masterbrain §10.2
 * "actual future path"). Paths start at each player's position at the future's
 * origin frame (the last observed frame); nothing is interpolated or predicted.
 */
import type { FuturePayload, PlayDetail } from "@/lib/contracts";
import type { Point } from "@/lib/tracking/geometry";
import { isPresent, type TrackingSeries } from "@/lib/tracking/series";

export interface GroundTruthPath {
  playerIndex: number;
  from: Point;
  points: Point[];
}

export interface GroundTruth {
  paths: GroundTruthPath[];
  landing: Point | null;
}

export function buildGroundTruth(
  series: TrackingSeries,
  detail: Pick<PlayDetail, "ball_landing"> | undefined,
  future: FuturePayload | undefined,
  show: { future: boolean; landing: boolean },
): GroundTruth | null {
  const paths: GroundTruthPath[] = [];
  const origin = future && future.id === series.playId ? series.frameIds.indexOf(future.origin_frame_id) : -1;
  if (show.future && future && origin >= 0) {
    for (const traj of future.trajectories) {
      const j = series.tracks.findIndex((t) => t.ref.player_id === traj.player_id);
      if (j < 0 || !isPresent(series.tracks[j], origin)) continue;
      const t = series.tracks[j];
      paths.push({ playerIndex: j, from: { x: t.x[origin], y: t.y[origin] }, points: traj.points.map((q) => ({ x: q.x, y: q.y })) });
    }
  }
  const b = detail?.ball_landing;
  const landing = show.landing && b ? { x: b.x, y: b.y } : null;
  return paths.length || landing ? { paths, landing } : null;
}
