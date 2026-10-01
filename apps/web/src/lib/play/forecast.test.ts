import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FramesPayloadSchema,
  FuturePayloadSchema,
  ModelInfoSchema,
  PlayDetailSchema,
  TrajectoryPredictionSchema,
  type ModelInfo,
} from "@/lib/contracts";
import { buildSeries } from "@/lib/tracking/series";
import { compareToActual, forecastOriginIndex, forecastPaths, isFixedOrigin, originProblem } from "./forecast";

const example = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../../../packages/contracts/examples/${name}`, import.meta.url), "utf8"));

const detail = PlayDetailSchema.parse(example("play-detail.json"));
const series = buildSeries(detail, FramesPayloadSchema.parse(example("frames.json")));
const prediction = TrajectoryPredictionSchema.parse(example("trajectory-prediction.json"));
const future = FuturePayloadSchema.parse(example("future.json"));
const [served] = ModelInfoSchema.array().parse(example("models.json"));
const last = series.times.length - 1;

describe("fixed-origin forecasts (real-data model)", () => {
  it("always start at the last observed frame", () => {
    expect(isFixedOrigin(served)).toBe(true);
    expect(forecastOriginIndex(series, served, 3)).toBe(last);
    expect(originProblem(series, last, served)).toBeNull();
    expect(originProblem(series, 3, served)).toMatch(/last observed frame/);
  });

  it("draw every target player, anchored at its tracked origin position, with the selection emphasized", () => {
    const target = prediction.players[0].player_id;
    const { primary, others } = forecastPaths(series, prediction, last, target, true);
    expect(primary?.path).toEqual(prediction.players[0].path);
    expect(others).toHaveLength(prediction.players.length - 1);
    const j = primary!.playerIndex;
    expect(primary!.origin).toEqual({ x: series.tracks[j].x[last], y: series.tracks[j].y[last] });
    const none = forecastPaths(series, prediction, last, null, true);
    expect(none.primary).toBeNull();
    expect(none.others).toHaveLength(prediction.players.length);
    expect(forecastPaths(series, prediction, last, target, false).others).toEqual([]);
  });

  it("scores a forecast against the held-out actual future by frame_id, ignoring invalid steps", () => {
    const c = compareToActual(prediction, future)!;
    expect(c.players).toBe(prediction.players.length);
    const validSteps = prediction.players.reduce((n, p) => n + p.valid.filter(Boolean).length, 0);
    expect(c.points).toBe(validSteps);
    expect(c.ade).toBeGreaterThanOrEqual(0);
    expect(c.fde).toBeGreaterThanOrEqual(0);
    // A perfect forecast scores zero.
    const truth = new Map(future.trajectories.map((t) => [t.player_id, t.points]));
    const perfect = {
      ...prediction,
      players: prediction.players.map((p) => ({
        ...p,
        path: p.path.map((q, k) => {
          const a = truth.get(p.player_id)?.find((pt) => pt.frame_id === prediction.future_frame_ids[k]);
          return a ? { x: a.x, y: a.y } : q;
        }),
      })),
    };
    expect(compareToActual(perfect, future)!.ade).toBeCloseTo(0, 6);
    expect(compareToActual({ ...prediction, play_id: "other" }, future)).toBeNull();
  });
});

describe("pinned-origin forecasts (fixture models)", () => {
  const pinnedModel: ModelInfo = {
    ...served,
    trajectory: { ...served.trajectory!, origin: "any_frame", input_window_frames: 2, origin_after_snap: false },
  };
  it("start at the current frame and need enough input frames", () => {
    expect(forecastOriginIndex(series, pinnedModel, 5)).toBe(5);
    expect(originProblem(series, 0, pinnedModel)).toMatch(/2 observed frames/);
    expect(originProblem(series, 5, pinnedModel)).toBeNull();
  });
});
