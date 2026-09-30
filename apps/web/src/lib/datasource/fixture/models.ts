/**
 * Models served by the development fixture. They run in the browser over the
 * same parsed tracking payload the UI renders:
 *
 * - cv-baseline-0: constant-velocity trajectory baseline (a real, if trivial,
 *   baseline) with sampled futures from an explicitly assumed velocity noise.
 * - descriptor-baseline-0: handcrafted formation descriptor + exact cosine
 *   search. Not a learned embedding.
 * - mock-rule-0: development mock for PlayLab. Role-speed priors with
 *   nearest-player pursuit. Not a trained model; it exists so the counterfactual
 *   interface can be exercised before the served model exists.
 *
 * None of these have evaluation runs, so Evaluation reports them as pending.
 */
import type {
  CompareMeasure,
  ModelInfo,
  PlayDetail,
  PlayLabConfig,
  PredictedPlayer,
} from "@/lib/contracts";
import { ApiError } from "@/lib/contracts";
import { FIELD_LENGTH, FIELD_WIDTH, isFlipped, toDisplay, toSource, type Point } from "@/lib/tracking/geometry";
import { frameIndexAt, isPresent, type TrackingSeries } from "@/lib/tracking/series";
import { validateEdit } from "@/lib/playlab/validate";
import { hashString, Rng } from "./random";

export { validateEdit };

export const CV_MODEL = "cv-baseline-0";
export const DESCRIPTOR_MODEL = "descriptor-baseline-0";
export const MOCK_MODEL = "mock-rule-0";

export const CV_HORIZONS = [1, 2, 3];
const CV_SAMPLES = 24;
const HEADING_SD_DEG = 12;
const SPEED_SD = 0.15;

export function fixtureModels(corpusSize: number): ModelInfo[] {
  return [
    {
      model_version: CV_MODEL,
      task: "trajectory",
      kind: "baseline",
      name: "Constant-velocity baseline",
      description:
        "Extrapolates each player's last observed velocity (finite difference of the two most recent frames). Uses no other players.",
      served: true,
      evaluation_status: "pending",
      trajectory: {
        horizons_s: CV_HORIZONS,
        input_window_frames: 2,
        uncertainty: "samples",
        uncertainty_note: `${CV_SAMPLES} sampled futures from assumed velocity noise (heading σ ${HEADING_SD_DEG}°, speed σ ${SPEED_SD * 100}%). Nominal and uncalibrated.`,
        origin_rule: "Any frame from the snap onward whose previous frame is tracked.",
        origin_after_snap: true,
      },
      retrieval: null,
    },
    {
      model_version: DESCRIPTOR_MODEL,
      task: "retrieval",
      kind: "baseline",
      name: "Formation descriptor baseline",
      description:
        "Relative player positions at the snap and 2.0 s later, sorted by side and width (88 values), mean-centered and L2-normalized. Handcrafted; not a learned embedding.",
      served: true,
      evaluation_status: "pending",
      trajectory: null,
      retrieval: { representation: "Handcrafted formation descriptor (88 dims)", distance: "cosine", index: "exact", corpus_size: corpusSize },
    },
    {
      model_version: MOCK_MODEL,
      task: "counterfactual",
      kind: "mock",
      name: "PlayLab development mock",
      description:
        "Role-speed priors with nearest-player pursuit from the editable pre-snap frame. Not a trained model; outputs only exercise the PlayLab interface.",
      served: true,
      evaluation_status: "unavailable",
      trajectory: null,
      retrieval: null,
    },
  ];
}

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
let requestCounter = 0;
export const nextRequestId = (prefix: string) => `${prefix}-${(++requestCounter).toString(36).padStart(4, "0")}`;

/* ---------------- Constant-velocity baseline ---------------- */

export function cvOriginProblem(series: TrackingSeries, originIndex: number): string | null {
  if (originIndex < 1 || originIndex >= series.times.length) return "Origin frame is outside the recording.";
  if (series.snapIndex !== null && originIndex < series.snapIndex) return "Forecast origins start at the snap.";
  if (series.gaps.some((g) => g.afterIndex === originIndex - 1)) return "The previous frame is missing (tracking gap).";
  return null;
}

export function cvPredict(
  series: TrackingSeries,
  originIndex: number,
  horizon: number,
  playerIds: string[] | null,
): { players: PredictedPlayer[]; step: number; latency: number } {
  const t0 = now();
  const step = 1 / series.frameRate;
  const steps = Math.round(horizon / step);
  const dt = series.times[originIndex] - series.times[originIndex - 1];
  const players: PredictedPlayer[] = [];
  for (const track of series.tracks) {
    if (playerIds && !playerIds.includes(track.ref.player_id)) continue;
    const o = originIndex;
    if (!isPresent(track, o) || !isPresent(track, o - 1)) {
      players.push({ player_id: track.ref.player_id, path: [], valid: [], samples: null });
      continue;
    }
    const vx = (track.x[o] - track.x[o - 1]) / dt;
    const vy = (track.y[o] - track.y[o - 1]) / dt;
    const path: Point[] = [];
    const valid: boolean[] = [];
    for (let k = 1; k <= steps; k++) {
      const p = { x: track.x[o] + vx * k * step, y: track.y[o] + vy * k * step };
      path.push(p);
      valid.push(p.x >= 0 && p.x <= FIELD_LENGTH && p.y >= 0 && p.y <= FIELD_WIDTH);
    }
    const rng = new Rng(hashString(`${series.playId}:${o}:${track.ref.player_id}`));
    const samples: Point[][] = [];
    for (let s = 0; s < CV_SAMPLES; s++) {
      const dh = (rng.normal(0, HEADING_SD_DEG) * Math.PI) / 180;
      const f = Math.max(0, rng.normal(1, SPEED_SD));
      const sx = (vx * Math.cos(dh) - vy * Math.sin(dh)) * f;
      const sy = (vx * Math.sin(dh) + vy * Math.cos(dh)) * f;
      const sp: Point[] = [];
      for (let k = 1; k <= steps; k++) sp.push({ x: track.x[o] + sx * k * step, y: track.y[o] + sy * k * step });
      samples.push(sp);
    }
    players.push({ player_id: track.ref.player_id, path, valid, samples });
  }
  return { players, step, latency: now() - t0 };
}

/* ---------------- Formation descriptor ---------------- */

interface Normalized {
  pos(track: number, i: number): Point | null;
  los: number;
  centerY: number;
}

function normalizedView(series: TrackingSeries, i: number): Normalized | null {
  const flipped = isFlipped(series.direction, "normalized");
  const pos = (t: number, k: number) => {
    const tr = series.tracks[t];
    if (!isPresent(tr, k)) return null;
    return toDisplay(tr.x[k], tr.y[k], flipped);
  };
  let los: number | null = null;
  if (series.losX !== null) los = toDisplay(series.losX, 0, flipped).x;
  let centerY: number | null = null;
  if (series.ball && Number.isFinite(series.ball.x[i])) {
    const b = toDisplay(series.ball.x[i], series.ball.y[i], flipped);
    centerY = b.y;
    if (los === null) los = b.x;
  }
  if (los === null || centerY === null) {
    const off = series.tracks.map((_, t) => (series.tracks[t].ref.side === "offense" ? pos(t, i) : null)).filter((p): p is Point => !!p);
    if (!off.length) return null;
    if (los === null) los = Math.max(...off.map((p) => p.x));
    if (centerY === null) centerY = off.reduce((a, p) => a + p.y, 0) / off.length;
  }
  return { pos, los, centerY };
}

export function formationDescriptor(series: TrackingSeries): Float64Array | null {
  if (series.snapIndex === null) return null;
  const i0 = series.snapIndex;
  const i2 = frameIndexAt(series.times, series.times[i0] + 2.0);
  const view = normalizedView(series, i0);
  if (!view) return null;
  const out = new Float64Array(88);
  let k = 0;
  for (const side of ["offense", "defense"] as const) {
    const members = series.tracks
      .map((t, idx) => ({ idx, t, p: view.pos(idx, i0) }))
      .filter((m) => m.t.ref.side === side && m.p)
      .sort((a, b) => a.p!.y - b.p!.y)
      .slice(0, 11);
    for (let slot = 0; slot < 11; slot++) {
      const m = members[slot];
      if (!m) {
        k += 4;
        continue;
      }
      const p0 = m.p!;
      const p2 = view.pos(m.idx, i2) ?? p0;
      out[k++] = p0.x - view.los;
      out[k++] = p0.y - view.centerY;
      out[k++] = p2.x - view.los;
      out[k++] = p2.y - view.centerY;
    }
  }
  return out;
}

export function normalizeCorpus(vectors: Map<string, Float64Array>): Map<string, Float64Array> {
  const dim = 88;
  const mean = new Float64Array(dim);
  for (const v of vectors.values()) for (let i = 0; i < dim; i++) mean[i] += v[i] / vectors.size;
  const out = new Map<string, Float64Array>();
  for (const [id, v] of vectors) {
    const c = new Float64Array(dim);
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      c[i] = v[i] - mean[i];
      norm += c[i] * c[i];
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) c[i] /= norm;
    out.set(id, c);
  }
  return out;
}

export function cosineSimilarity(a: Float64Array, b: Float64Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/* ---------------- Compare measures ---------------- */

const SKILL = new Set(["WR", "TE", "RB"]);

function snapMeasures(series: TrackingSeries) {
  if (series.snapIndex === null) return null;
  const i0 = series.snapIndex;
  const view = normalizedView(series, i0);
  if (!view) return null;
  const offense = series.tracks.map((t, i) => ({ t, i })).filter((m) => m.t.ref.side === "offense");
  const defense = series.tracks.map((t, i) => ({ t, i })).filter((m) => m.t.ref.side === "defense");
  const offY = offense.map((m) => view.pos(m.i, i0)).filter((p): p is Point => !!p).map((p) => p.y);
  const depth = defense.map((m) => view.pos(m.i, i0)).filter((p): p is Point => !!p).map((p) => p.x - view.los);
  const i2 = frameIndexAt(series.times, series.times[i0] + 2.0);
  const reached2 = series.times[i2] >= series.times[i0] + 2.0 - 1e-6;
  const seps: number[] = [];
  if (reached2) {
    for (const m of offense) {
      if (!SKILL.has(m.t.ref.position ?? "")) continue;
      const p = view.pos(m.i, i2);
      if (!p) continue;
      let best = Infinity;
      for (const d of defense) {
        const q = view.pos(d.i, i2);
        if (q) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
      }
      if (Number.isFinite(best)) seps.push(best);
    }
  }
  const i3 = frameIndexAt(series.times, series.times[i0] + 3.0);
  let peak = -Infinity;
  for (const m of offense) for (let k = i0; k <= i3; k++) if (Number.isFinite(m.t.s[k])) peak = Math.max(peak, m.t.s[k]);
  const throwEvent = series.events.find((e) => e.kind === "throw");
  return {
    width: offY.length ? Math.max(...offY) - Math.min(...offY) : null,
    depth: depth.length ? depth.reduce((a, b) => a + b, 0) / depth.length : null,
    sep2: seps.length ? seps.reduce((a, b) => a + b, 0) / seps.length : null,
    sep2Reason: reached2 ? (seps.length ? null : "No tracked skill players at +2.0 s") : "Recording ends before +2.0 s",
    peak: Number.isFinite(peak) ? peak : null,
    ttt: throwEvent ? throwEvent.time - series.times[i0] : null,
    view,
  };
}

export function compareMeasures(left: TrackingSeries, right: TrackingSeries): CompareMeasure[] {
  const l = snapMeasures(left);
  const r = snapMeasures(right);
  const noSnap = "No snap event; the snap-relative window is undefined";
  const reason = (a: unknown, b: unknown, fallback: string) =>
    !l || !r ? noSnap : a === null || b === null ? fallback : null;
  return [
    {
      key: "offense_width",
      label: "Offense width at snap",
      unit: "yd",
      decimals: 1,
      left: l?.width ?? null,
      right: r?.width ?? null,
      missing_reason: reason(l?.width, r?.width, "No tracked offense at snap"),
      definition: "Lateral distance between the widest two tracked offensive players at the snap frame.",
    },
    {
      key: "defender_depth",
      label: "Mean defender depth at snap",
      unit: "yd",
      decimals: 1,
      left: l?.depth ?? null,
      right: r?.depth ?? null,
      missing_reason: reason(l?.depth, r?.depth, "No tracked defenders at snap"),
      definition: "Mean distance of tracked defenders beyond the line of scrimmage at the snap frame.",
    },
    {
      key: "skill_separation_2s",
      label: "Mean skill-player separation at +2.0 s",
      unit: "yd",
      decimals: 1,
      left: l?.sep2 ?? null,
      right: r?.sep2 ?? null,
      missing_reason: reason(l?.sep2, r?.sep2, (l?.sep2 === null ? l?.sep2Reason : r?.sep2Reason) ?? "Unavailable"),
      definition: "Mean distance from each tracked WR, TE, and RB to the nearest tracked defender 2.0 s after the snap.",
    },
    {
      key: "peak_offense_speed",
      label: "Peak offense speed, snap to +3.0 s",
      unit: "yd/s",
      decimals: 1,
      left: l?.peak ?? null,
      right: r?.peak ?? null,
      missing_reason: reason(l?.peak, r?.peak, "Speed not tracked in window"),
      definition: "Maximum tracked speed among offensive players from the snap to 3.0 s after it.",
    },
    {
      key: "time_to_throw",
      label: "Time to throw",
      unit: "s",
      decimals: 1,
      left: l?.ttt ?? null,
      right: r?.ttt ?? null,
      missing_reason: reason(l?.ttt, r?.ttt, "No throw event in one or both plays"),
      definition: "Time from the snap event to the supplied pass_forward event.",
    },
  ];
}

export function snapCorrespondence(left: TrackingSeries, right: TrackingSeries) {
  const l = snapMeasures(left);
  const r = snapMeasures(right);
  if (!l || !r) return null;
  const pairs: Array<{ left_player_id: string; right_player_id: string }> = [];
  for (const side of ["offense", "defense"] as const) {
    const rel = (s: TrackingSeries, view: Normalized, i: number) =>
      s.tracks
        .map((t, idx) => ({ id: t.ref.player_id, side: t.ref.side, p: view.pos(idx, i) }))
        .filter((m) => m.side === side && m.p)
        .map((m) => ({ id: m.id, x: m.p!.x - view.los, y: m.p!.y - view.centerY }));
    const a = rel(left, l.view, left.snapIndex!);
    const b = rel(right, r.view, right.snapIndex!);
    const cand: Array<{ i: number; j: number; d: number }> = [];
    a.forEach((pa, i) => b.forEach((pb, j) => cand.push({ i, j, d: Math.hypot(pa.x - pb.x, pa.y - pb.y) })));
    cand.sort((p, q) => p.d - q.d);
    const usedA = new Set<number>();
    const usedB = new Set<number>();
    for (const c of cand) {
      if (usedA.has(c.i) || usedB.has(c.j)) continue;
      usedA.add(c.i);
      usedB.add(c.j);
      pairs.push({ left_player_id: a[c.i].id, right_player_id: b[c.j].id });
    }
  }
  return { method: "Nearest relative position at the snap, same side (greedy). Computed; not an assignment.", pairs };
}

/* ---------------- PlayLab development mock ---------------- */

const MAX_DISPLACEMENT = 5;
const OOD_DISPLACEMENT = 3.5;
const MOCK_HORIZON = 3;

export function playLabConfig(detail: PlayDetail, series: TrackingSeries): PlayLabConfig {
  const bounds = { x_min: 0, x_max: FIELD_LENGTH, y_min: 0, y_max: FIELD_WIDTH };
  const base = {
    play_id: detail.play_id,
    field_bounds: bounds,
    constraints: [],
    eligible_player_ids: [],
    ood_displacement_yd: null,
    model_version: null,
    model_kind: null,
    model_note: null,
    editable_frame_id: null,
    input_window: null,
    horizon_s: null,
    step_s: null,
    max_displacement_yd: null,
  } satisfies Partial<PlayLabConfig>;
  if (series.snapIndex === null || series.snapIndex < 1) {
    return { ...base, available: false, unavailable_reason: "This play has no snap event, so no pre-snap frame can be identified for editing." };
  }
  if (series.losX === null || series.direction === null) {
    return { ...base, available: false, unavailable_reason: "Line of scrimmage or play direction is missing, so the allowed region cannot be defined." };
  }
  const e = series.snapIndex - 1;
  const los = series.losX;
  const constraint =
    series.direction === "right"
      ? { nx: 1, ny: 0, c: los + 1 }
      : { nx: -1, ny: 0, c: -(los - 1) };
  return {
    ...base,
    available: true,
    unavailable_reason: null,
    model_version: MOCK_MODEL,
    model_kind: "mock",
    model_note: "Development mock: role-speed priors with nearest-player pursuit. Not a trained model.",
    editable_frame_id: series.frameIds[e],
    input_window: { start_frame_id: series.frameIds[Math.max(0, e - 9)], end_frame_id: series.frameIds[e] },
    horizon_s: MOCK_HORIZON,
    step_s: 1 / series.frameRate,
    max_displacement_yd: MAX_DISPLACEMENT,
    constraints: [{ ...constraint, description: "At least 1 yd beyond the line of scrimmage (outside the neutral zone)" }],
    eligible_player_ids: series.tracks.filter((t) => t.ref.side === "defense" && isPresent(t, e)).map((t) => t.ref.player_id),
    ood_displacement_yd: OOD_DISPLACEMENT,
  };
}

interface MockBody {
  side: "offense" | "defense";
  position: string;
  pos: Point;
  vel: Point;
  ref: number;
}

function mockRollout(series: TrackingSeries, e: number, override: { index: number; pos: Point } | null) {
  const flipped = isFlipped(series.direction, "normalized");
  const los = toDisplay(series.losX!, 0, flipped).x;
  const qbIndex = series.tracks.findIndex((t) => t.ref.position === "QB");
  const bodies: Array<MockBody | null> = series.tracks.map((t, i) => {
    if (!isPresent(t, e)) return null;
    const src = override && override.index === i ? override.pos : { x: t.x[e], y: t.y[e] };
    return { side: t.ref.side, position: t.ref.position ?? "", pos: toDisplay(src.x, src.y, flipped), vel: { x: 0, y: 0 }, ref: -1 };
  });
  const centerY =
    bodies.filter((b): b is MockBody => !!b && b.side === "offense").reduce((a, b, _, arr) => a + b.pos.y / arr.length, 0) || FIELD_WIDTH / 2;
  bodies.forEach((b) => {
    if (!b || b.side !== "defense" || b.position === "DE" || b.position === "DT") return;
    let best = -1;
    let bestD = Infinity;
    bodies.forEach((o, j) => {
      if (!o || o.side !== "offense" || !SKILL.has(o.position)) return;
      const d = Math.hypot(o.pos.x - b.pos.x, o.pos.y - b.pos.y);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    });
    b.ref = best;
  });

  const step = 1 / series.frameRate;
  const steps = Math.round(MOCK_HORIZON / step);
  const sub = 5;
  const h = step / sub;
  const paths: Point[][] = bodies.map(() => []);
  for (let k = 1; k <= steps; k++) {
    for (let s = 0; s < sub; s++) {
      const tau = (k - 1) * step + (s + 1) * h - step;
      bodies.forEach((b) => {
        if (!b || b.side !== "offense") return;
        if (tau <= 0) return;
        const p = b.position;
        if (p === "WR" || p === "TE") {
          const vmax = p === "WR" ? 7.5 : 5.5;
          b.vel.x = Math.min(vmax, b.vel.x + 4 * h);
        } else if (p === "RB") {
          const out = b.pos.y >= centerY ? 1 : -1;
          b.vel.x = Math.min(1.5, b.vel.x + 3 * h);
          b.vel.y = out * Math.min(4.5, Math.abs(b.vel.y) + 4 * h);
        } else if (p === "QB") {
          b.vel.x = tau < 1 ? -2 : 0;
        } else {
          b.vel.x = tau < 1 ? -1.2 : 0;
        }
        b.pos.x += b.vel.x * h;
        b.pos.y = Math.min(FIELD_WIDTH, Math.max(0, b.pos.y + b.vel.y * h));
      });
      bodies.forEach((b) => {
        if (!b || b.side !== "defense" || tau <= 0) return;
        let target: Point;
        let vmax = 7.5;
        if (b.position === "DE" || b.position === "DT") {
          const qb = qbIndex >= 0 ? bodies[qbIndex] : null;
          target = qb ? { x: Math.max(los - 1.5, qb.pos.x), y: qb.pos.y } : { x: los - 1.5, y: b.pos.y };
          vmax = 2.5;
        } else if (b.ref >= 0 && bodies[b.ref]) {
          const r = bodies[b.ref]!;
          const deep = b.position === "FS" || b.position === "SS";
          target = { x: r.pos.x + (deep ? 6 : 1.5), y: r.pos.y };
        } else {
          target = b.pos;
        }
        const dx = target.x - b.pos.x;
        const dy = target.y - b.pos.y;
        const d = Math.hypot(dx, dy);
        const want = d < 1e-6 ? 0 : Math.min(vmax, d / 0.4);
        let ax = ((d < 1e-6 ? 0 : (dx / d) * want) - b.vel.x) / h;
        let ay = ((d < 1e-6 ? 0 : (dy / d) * want) - b.vel.y) / h;
        const am = Math.hypot(ax, ay);
        if (am > 6) {
          ax = (ax / am) * 6;
          ay = (ay / am) * 6;
        }
        b.vel.x += ax * h;
        b.vel.y += ay * h;
        b.pos.x += b.vel.x * h;
        b.pos.y = Math.min(FIELD_WIDTH, Math.max(0, b.pos.y + b.vel.y * h));
      });
    }
    bodies.forEach((b, i) => {
      if (b) paths[i].push(toSource(b.pos.x, b.pos.y, flipped));
    });
  }
  return paths;
}

function toPredicted(series: TrackingSeries, paths: Point[][]): PredictedPlayer[] {
  return series.tracks.map((t, i) => ({
    player_id: t.ref.player_id,
    path: paths[i],
    valid: paths[i].map((p) => p.x >= 0 && p.x <= FIELD_LENGTH && p.y >= 0 && p.y <= FIELD_WIDTH),
    samples: null,
  }));
}

export function mockCounterfactual(series: TrackingSeries, config: PlayLabConfig, playerId: string, proposed: Point) {
  const t0 = now();
  if (!config.available || config.editable_frame_id === null) throw new ApiError(config.unavailable_reason ?? "PlayLab unavailable", 422, "user");
  const e = series.frameIds.indexOf(config.editable_frame_id);
  const index = series.tracks.findIndex((t) => t.ref.player_id === playerId);
  if (index < 0 || !config.eligible_player_ids.includes(playerId)) throw new ApiError("This player cannot be edited in this play.", 422, "user");
  const track = series.tracks[index];
  const original = { x: track.x[e], y: track.y[e] };
  const problem = validateEdit(config, original, proposed);
  if (problem) throw new ApiError(`Edit rejected: ${problem}`, 422, "user");

  const origPaths = mockRollout(series, e, null);
  const modPaths = mockRollout(series, e, { index, pos: proposed });
  const last = (p: Point[]) => p[p.length - 1];
  const nearestOffense = (paths: Point[][], k: number, from: Point) => {
    let best = Infinity;
    series.tracks.forEach((t, j) => {
      if (t.ref.side !== "offense" || !paths[j].length) return;
      const q = paths[j][k];
      best = Math.min(best, Math.hypot(q.x - from.x, q.y - from.y));
    });
    return Number.isFinite(best) ? best : null;
  };
  const minOverHorizon = (paths: Point[][]) => {
    let m = Infinity;
    paths[index].forEach((p, k) => {
      const d = nearestOffense(paths, k, p);
      if (d !== null) m = Math.min(m, d);
    });
    return Number.isFinite(m) ? m : null;
  };
  const skillSeparation = (paths: Point[][]) => {
    const k = paths[index].length - 1;
    const vals: number[] = [];
    series.tracks.forEach((t, j) => {
      if (t.ref.side !== "offense" || !SKILL.has(t.ref.position ?? "") || !paths[j].length) return;
      let best = Infinity;
      series.tracks.forEach((d, m) => {
        if (d.ref.side !== "defense" || !paths[m].length) return;
        best = Math.min(best, Math.hypot(paths[j][k].x - paths[m][k].x, paths[j][k].y - paths[m][k].y));
      });
      if (Number.isFinite(best)) vals.push(best);
    });
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  };
  const pathLength = (p: Point[], from: Point) =>
    p.reduce((acc, q, k) => acc + Math.hypot(q.x - (k ? p[k - 1].x : from.x), q.y - (k ? p[k - 1].y : from.y)), 0);
  const kEnd = origPaths[index].length - 1;
  const displacement = Math.hypot(proposed.x - original.x, proposed.y - original.y);

  const measures = [
    {
      key: "displacement",
      label: "Displacement at editable frame",
      unit: "yd",
      decimals: 1,
      original: 0,
      modified: displacement,
      definition: "Distance between the source position and the modified position of the selected defender at the editable frame.",
    },
    {
      key: "nearest_offense_end",
      label: `Selected defender to nearest offense at +${MOCK_HORIZON.toFixed(1)} s`,
      unit: "yd",
      decimals: 1,
      original: nearestOffense(origPaths, kEnd, last(origPaths[index])),
      modified: nearestOffense(modPaths, kEnd, last(modPaths[index])),
      definition: "Predicted distance from the selected defender to the nearest offensive player at the end of the horizon.",
    },
    {
      key: "nearest_offense_min",
      label: "Selected defender to nearest offense, minimum over horizon",
      unit: "yd",
      decimals: 1,
      original: minOverHorizon(origPaths),
      modified: minOverHorizon(modPaths),
      definition: "Smallest predicted distance from the selected defender to any offensive player across the horizon.",
    },
    {
      key: "skill_separation_end",
      label: `Mean skill-player separation at +${MOCK_HORIZON.toFixed(1)} s`,
      unit: "yd",
      decimals: 1,
      original: skillSeparation(origPaths),
      modified: skillSeparation(modPaths),
      definition: "Mean predicted distance from each WR, TE, and RB to the nearest defender at the end of the horizon.",
    },
    {
      key: "path_length",
      label: "Selected defender predicted path length",
      unit: "yd",
      decimals: 1,
      original: pathLength(origPaths[index], original),
      modified: pathLength(modPaths[index], proposed),
      definition: "Length of the selected defender's predicted path over the horizon.",
    },
  ];

  const warnings =
    config.ood_displacement_yd !== null && displacement > config.ood_displacement_yd
      ? [
          {
            code: "out_of_distribution",
            message: `Displacement exceeds ${config.ood_displacement_yd.toFixed(1)} yd, the configured range for this model. Treat the result as out of distribution.`,
          },
        ]
      : [];

  return {
    original: toPredicted(series, origPaths),
    modified: toPredicted(series, modPaths),
    originalPosition: original,
    measures,
    warnings,
    latency: now() - t0,
  };
}
