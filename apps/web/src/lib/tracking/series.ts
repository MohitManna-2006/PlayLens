/**
 * Columnar, frame-indexed view of one play's tracking payload. Frames are
 * sorted by frame_id (a documented, unique key); absent players are NaN, not
 * interpolated. Gaps are detected from frame_id jumps and never bridged.
 */
import type { FramesPayload, PlayDetail, PlayerRef } from "@/lib/contracts";
import { ApiError } from "@/lib/contracts";
import type { Extent } from "./geometry";
import { clampToField, isFlipped, padExtent, toDisplay, type Orientation } from "./geometry";

export type EventKind = "snap" | "throw" | "arrival" | "catch" | "other";

export interface SeriesEvent {
  index: number;
  frameId: number;
  time: number;
  code: string;
  label: string;
  kind: EventKind;
}

export interface PlayerTrack {
  ref: PlayerRef;
  x: Float64Array;
  y: Float64Array;
  s: Float64Array;
  a: Float64Array;
  dir: Float64Array;
  o: Float64Array;
}

export interface Gap {
  /** Last valid index before the missing interval. */
  afterIndex: number;
  startFrameId: number;
  endFrameId: number;
  startTime: number;
  endTime: number;
}

export interface TrackingSeries {
  playId: string;
  direction: PlayDetail["play_direction"];
  frameRate: number;
  frameIds: number[];
  times: number[];
  tracks: PlayerTrack[];
  ball: { x: Float64Array; y: Float64Array } | null;
  gaps: Gap[];
  events: SeriesEvent[];
  snapIndex: number | null;
  losX: number | null;
  firstDownX: number | null;
}

const EVENT_LABELS: Record<string, { label: string; kind: EventKind }> = {
  ball_snap: { label: "Snap", kind: "snap" },
  autoevent_ballsnap: { label: "Snap", kind: "snap" },
  pass_forward: { label: "Throw", kind: "throw" },
  autoevent_passforward: { label: "Throw", kind: "throw" },
  pass_arrived: { label: "Arrival", kind: "arrival" },
  pass_outcome_caught: { label: "Catch", kind: "catch" },
  pass_outcome_incomplete: { label: "Incomplete", kind: "arrival" },
  handoff: { label: "Handoff", kind: "other" },
  tackle: { label: "Tackle", kind: "other" },
  first_contact: { label: "First contact", kind: "other" },
  out_of_bounds: { label: "Out of bounds", kind: "other" },
  line_set: { label: "Line set", kind: "other" },
  man_in_motion: { label: "Motion", kind: "other" },
  qb_sack: { label: "Sack", kind: "other" },
  touchdown: { label: "Touchdown", kind: "other" },
};

export function describeEvent(code: string): { label: string; kind: EventKind } {
  return (
    EVENT_LABELS[code] ?? {
      label: code.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
      kind: "other",
    }
  );
}

export function buildSeries(detail: PlayDetail, payload: FramesPayload): TrackingSeries {
  if (payload.id !== detail.id) {
    throw new ApiError(`Frames for play ${payload.id} were returned for play ${detail.id}.`, null, "contract");
  }
  const frames = [...payload.frames].sort((a, b) => a.frame_id - b.frame_id);
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].frame_id === frames[i - 1].frame_id) {
      throw new ApiError(`Duplicate frame ${frames[i].frame_id} in play ${detail.id}`, null, "contract");
    }
  }
  if (frames.length === 0) throw new ApiError(`Play ${detail.id} has no tracking frames.`, null, "contract");
  const n = frames.length;
  const frameIds = frames.map((f) => f.frame_id);
  const times = frames.map((f) => f.time_s);

  const tracks: PlayerTrack[] = detail.players.map((ref) => ({
    ref,
    x: new Float64Array(n).fill(NaN),
    y: new Float64Array(n).fill(NaN),
    s: new Float64Array(n).fill(NaN),
    a: new Float64Array(n).fill(NaN),
    dir: new Float64Array(n).fill(NaN),
    o: new Float64Array(n).fill(NaN),
  }));
  const byId = new Map(tracks.map((t, i) => [t.ref.player_id, i]));

  let hasBall = false;
  const ballX = new Float64Array(n).fill(NaN);
  const ballY = new Float64Array(n).fill(NaN);

  frames.forEach((frame, i) => {
    if (frame.ball) {
      hasBall = true;
      ballX[i] = frame.ball.x;
      ballY[i] = frame.ball.y;
    }
    for (const p of frame.players) {
      const ti = byId.get(p.player_id);
      if (ti === undefined) {
        throw new ApiError(`Frame ${frame.frame_id} of play ${detail.id} has player ${p.player_id}, who is not in the roster.`, null, "contract");
      }
      const t = tracks[ti];
      t.x[i] = p.x;
      t.y[i] = p.y;
      t.s[i] = p.s ?? NaN;
      t.a[i] = p.a ?? NaN;
      t.dir[i] = p.dir ?? NaN;
      t.o[i] = p.o ?? NaN;
    }
  });

  const period = 1 / detail.frame_rate_hz;
  const gaps: Gap[] = [];
  for (let i = 0; i < n - 1; i++) {
    const idJump = frameIds[i + 1] - frameIds[i] > 1;
    const timeJump = times[i + 1] - times[i] > period * 1.5;
    if (idJump || timeJump) {
      gaps.push({
        afterIndex: i,
        startFrameId: frameIds[i] + 1,
        endFrameId: frameIds[i + 1] - 1,
        startTime: times[i],
        endTime: times[i + 1],
      });
    }
  }

  const indexOfFrame = new Map(frameIds.map((id, i) => [id, i]));
  const events: SeriesEvent[] = detail.events
    .filter((e) => indexOfFrame.has(e.frame_id))
    .map((e) => {
      const index = indexOfFrame.get(e.frame_id)!;
      const d = describeEvent(e.event);
      return { index, frameId: e.frame_id, time: times[index], code: e.event, label: d.label, kind: d.kind };
    })
    .sort((a, b) => a.index - b.index);

  const snap = events.find((e) => e.kind === "snap");

  return {
    playId: detail.id,
    direction: detail.play_direction,
    frameRate: detail.frame_rate_hz,
    frameIds,
    times,
    tracks,
    ball: hasBall ? { x: ballX, y: ballY } : null,
    gaps,
    events,
    snapIndex: snap ? snap.index : null,
    losX: detail.line_of_scrimmage_x,
    firstDownX: detail.first_down_x,
  };
}

/** Index of the last frame whose timestamp is ≤ t (clamped to the series). */
export function frameIndexAt(times: number[], t: number): number {
  if (times.length === 0) return 0;
  if (t <= times[0]) return 0;
  const last = times.length - 1;
  if (t >= times[last]) return last;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (times[mid] <= t + 1e-9) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Index of the frame nearest to t. Seeking resolves to real frames. */
export function nearestFrameIndex(times: number[], t: number): number {
  const i = frameIndexAt(times, t);
  if (i < times.length - 1 && Math.abs(times[i + 1] - t) < Math.abs(times[i] - t)) return i + 1;
  return i;
}

export function isPresent(track: PlayerTrack, i: number): boolean {
  return Number.isFinite(track.x[i]) && Number.isFinite(track.y[i]);
}

export function gapAfter(series: TrackingSeries, index: number): Gap | undefined {
  return series.gaps.find((g) => g.afterIndex === index);
}

/**
 * Stable camera for the Action view: extent of every tracked entity over
 * frames [0, lastIndex], padded 5 yd and clamped to the field (§7 Viewport).
 * In forecast review lastIndex is the pinned origin, so hidden future frames
 * never influence framing.
 */
export function actionExtent(
  series: TrackingSeries,
  orientation: Orientation,
  lastIndex = series.times.length - 1,
  pad = 5,
): Extent {
  const flipped = isFlipped(series.direction, orientation);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  const take = (x: number, y: number) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const p = toDisplay(x, y, flipped);
    if (p.x < x0) x0 = p.x;
    if (p.x > x1) x1 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.y > y1) y1 = p.y;
  };
  for (let i = 0; i <= lastIndex; i++) {
    for (const t of series.tracks) take(t.x[i], t.y[i]);
    if (series.ball) take(series.ball.x[i], series.ball.y[i]);
  }
  if (!Number.isFinite(x0)) return { x0: 0, x1: 120, y0: 0, y1: 160 / 3 };
  return clampToField(padExtent({ x0, x1, y0, y1 }, pad));
}
