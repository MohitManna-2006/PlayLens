/**
 * In-browser implementation of the /api/v1 contract over synthetic plays.
 * Enabled with NEXT_PUBLIC_PLAYLENS_DATA_SOURCE=fixture (the default when no
 * API is configured). See docs/decisions/ADR-0001-web-fixture-data-source.md.
 */
import type {
  CompareResult,
  CounterfactualRequest,
  CounterfactualResult,
  DatasetStatus,
  EvaluationReport,
  Facets,
  FramesPayload,
  PlayDetail,
  PlayPage,
  PlayQuery,
  SimilarRequest,
  SimilarResult,
  TrajectoryPrediction,
  TrajectoryRequest,
} from "@/lib/contracts";
import { ApiError, SCHEMA_VERSION } from "@/lib/contracts";
import { angleToDisplay, isFlipped, toSource } from "@/lib/tracking/geometry";
import { buildSeries, type TrackingSeries } from "@/lib/tracking/series";
import type { RawSource } from "../types";
import {
  compareMeasures,
  cosineSimilarity,
  CV_HORIZONS,
  CV_MODEL,
  cvOriginProblem,
  cvPredict,
  DESCRIPTOR_MODEL,
  fixtureModels,
  formationDescriptor,
  mockCounterfactual,
  nextRequestId,
  normalizeCorpus,
  playLabConfig,
  snapCorrespondence,
} from "./models";
import { Rng } from "./random";
import { FRAME_RATE, GAME_COUNT, PLAYS_PER_GAME, simulate, TEAMS, type SimPlay } from "./simulate";

const DATASET: DatasetStatus = {
  dataset_version: "fixture-v1",
  play_count: GAME_COUNT * PLAYS_PER_GAME,
  source: "PlayLens procedural fixture (synthetic)",
  synthetic: true,
};

function checkAbort(signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
}

export class FixtureSource implements RawSource {
  readonly kind = "fixture" as const;
  private plays: SimPlay[] | null = null;
  private byId = new Map<string, SimPlay>();
  private details = new Map<string, PlayDetail>();
  private frames = new Map<string, FramesPayload>();
  private seriesCache = new Map<string, TrackingSeries>();
  private descriptors: Map<string, Float64Array> | null = null;

  private all(): SimPlay[] {
    if (!this.plays) {
      const out: SimPlay[] = [];
      for (let g = 0; g < GAME_COUNT; g++) for (let s = 1; s <= PLAYS_PER_GAME; s++) out.push(simulate(g, s));
      this.plays = out;
      for (const p of out) this.byId.set(p.summary.play_id, p);
    }
    return this.plays;
  }

  private play(id: string): SimPlay {
    this.all();
    const p = this.byId.get(id);
    if (!p) throw new ApiError(`Play ${id} was not found.`, 404, "user");
    return p;
  }

  private detail(id: string): PlayDetail {
    const cached = this.details.get(id);
    if (cached) return cached;
    const p = this.play(id);
    const flipped = isFlipped(p.direction, "normalized");
    const d: PlayDetail = {
      ...p.summary,
      players: p.refs,
      events: p.events.filter((e) => !p.missing.has(e.index)).map((e) => ({ frame_id: e.index + 1, event: e.event })),
      play_direction: p.direction,
      line_of_scrimmage_x: toSource(p.los, 0, flipped).x,
      first_down_x: p.firstDown === null ? null : toSource(p.firstDown, 0, flipped).x,
      frame_rate_hz: FRAME_RATE,
      provenance: {
        source: DATASET.source!,
        dataset_version: DATASET.dataset_version!,
        schema_version: SCHEMA_VERSION,
        coordinate_convention: "Source yards: x 0–120 including end zones, y 0–53.3; angles NGS (0° = +y, clockwise)",
        synthetic: true,
      },
    };
    this.details.set(id, d);
    return d;
  }

  private framesPayload(id: string): FramesPayload {
    const cached = this.frames.get(id);
    if (cached) return cached;
    const p = this.play(id);
    const flipped = isFlipped(p.direction, "normalized");
    const rng = new Rng(p.noiseSeed);
    const dt = 1 / FRAME_RATE;
    const frames: FramesPayload["frames"] = [];
    const lastDir: number[] = p.refs.map((r) => (r.side === "offense" ? 90 : 270));
    for (let i = 0; i < p.frameCount; i++) {
      if (p.missing.has(i)) continue;
      const players = [];
      for (let j = 0; j < p.refs.length; j++) {
        const drop = p.dropout.get(j);
        if (drop !== undefined && i >= drop) continue;
        const xs = p.xs[j];
        const ys = p.ys[j];
        const a = Math.max(0, i - 1);
        const b = Math.min(p.frameCount - 1, i + 1);
        const span = (b - a) * dt || dt;
        const vx = (xs[b] - xs[a]) / span;
        const vy = (ys[b] - ys[a]) / span;
        const s = Math.hypot(vx, vy);
        if (s > 0.15) lastDir[j] = ((Math.atan2(vx, vy) * 180) / Math.PI + 360) % 360;
        const a2 = Math.max(0, i - 2);
        const b2 = Math.min(p.frameCount - 1, i + 2);
        const vAt = (k: number) => {
          const k0 = Math.max(0, k - 1);
          const k1 = Math.min(p.frameCount - 1, k + 1);
          const sp = (k1 - k0) * dt || dt;
          return { x: (xs[k1] - xs[k0]) / sp, y: (ys[k1] - ys[k0]) / sp };
        };
        const va = vAt(a2);
        const vb = vAt(b2);
        const acc = Math.hypot(vb.x - va.x, vb.y - va.y) / (((b2 - a2) * dt) || dt);
        const src = toSource(xs[i] + rng.normal(0, 0.02), ys[i] + rng.normal(0, 0.02), flipped);
        players.push({
          player_id: p.refs[j].player_id,
          x: round(src.x, 2),
          y: round(src.y, 2),
          s: round(s, 2),
          a: round(acc, 2),
          dir: round(angleToDisplay(lastDir[j], flipped), 1),
          o: round(angleToDisplay(lastDir[j], flipped), 1),
        });
      }
      const ball = p.special === "no_ball" ? null : toSource(p.ballX[i], p.ballY[i], flipped);
      frames.push({
        frame_id: i + 1,
        time_s: round(i * dt, 3),
        ball: ball ? { x: round(ball.x, 2), y: round(ball.y, 2) } : null,
        players,
      });
    }
    const payload = { play_id: id, frames };
    this.frames.set(id, payload);
    return payload;
  }

  private series(id: string): TrackingSeries {
    const cached = this.seriesCache.get(id);
    if (cached) return cached;
    const s = buildSeries(this.detail(id), this.framesPayload(id));
    this.seriesCache.set(id, s);
    return s;
  }

  private descriptorIndex(): Map<string, Float64Array> {
    if (!this.descriptors) {
      const raw = new Map<string, Float64Array>();
      for (const p of this.all()) {
        const v = formationDescriptor(this.series(p.summary.play_id));
        if (v) raw.set(p.summary.play_id, v);
      }
      this.descriptors = normalizeCorpus(raw);
    }
    return this.descriptors;
  }

  async listPlays(q: PlayQuery, signal?: AbortSignal): Promise<PlayPage> {
    checkAbort(signal);
    const needle = q.q?.trim().toLowerCase();
    let items = this.all()
      .map((p) => p.summary)
      .filter((s) => {
        if (needle) {
          const hay = [s.play_id, s.game_id, s.home_team, s.away_team, s.offense, s.defense, s.description]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        if (q.season !== undefined && s.season !== q.season) return false;
        if (q.offense && s.offense !== q.offense) return false;
        if (q.defense && s.defense !== q.defense) return false;
        if (q.down !== undefined && s.down !== q.down) return false;
        if (q.distance) {
          const y = s.yards_to_go;
          if (y === null) return false;
          const band = y <= 3 ? "short" : y <= 7 ? "medium" : "long";
          if (band !== q.distance) return false;
        }
        if (q.play_type && s.play_type !== q.play_type) return false;
        if (q.quarter !== undefined && s.quarter !== q.quarter) return false;
        if (q.outcome) {
          const o = s.outcome_yards;
          const band = o === null ? "unknown" : o > 0 ? "gain" : o < 0 ? "loss" : "no_gain";
          if (band !== q.outcome) return false;
        }
        return true;
      });

    let similarity: PlayPage["similarity"] = null;
    if (q.sort === "similarity") {
      if (!q.similar_to) throw new ApiError("Similarity sort requires a source play.", 422, "user");
      const index = this.descriptorIndex();
      const src = index.get(q.similar_to);
      if (!src) throw new ApiError(`Play ${q.similar_to} has no descriptor (no snap event), so similarity is undefined.`, 422, "user");
      const scores: Record<string, number> = {};
      items = items.filter((s) => s.play_id !== q.similar_to && index.has(s.play_id));
      for (const s of items) scores[s.play_id] = cosineSimilarity(src, index.get(s.play_id)!);
      items.sort((a, b) => scores[b.play_id] - scores[a.play_id]);
      similarity = { source_play_id: q.similar_to, model_version: DESCRIPTOR_MODEL, scores };
    } else {
      items.sort((a, b) => (b.game_date ?? "").localeCompare(a.game_date ?? "") || a.play_sequence - b.play_sequence);
    }

    const total = items.length;
    const start = (q.page - 1) * q.page_size;
    return {
      items: items.slice(start, start + q.page_size),
      total,
      page: q.page,
      page_size: q.page_size,
      sort: q.sort,
      similarity: similarity
        ? { ...similarity, scores: Object.fromEntries(items.slice(start, start + q.page_size).map((s) => [s.play_id, similarity!.scores[s.play_id]])) }
        : null,
      dataset: DATASET,
    };
  }

  async getFacets(): Promise<Facets> {
    const all = this.all().map((p) => p.summary);
    return {
      seasons: [...new Set(all.map((s) => s.season).filter((s): s is number => s !== null))].sort((a, b) => b - a),
      teams: [...TEAMS],
      play_types: ["pass", "run"],
      quarters: [1, 2, 3, 4],
    };
  }

  async getPlay(id: string, signal?: AbortSignal): Promise<PlayDetail> {
    checkAbort(signal);
    return this.detail(id);
  }

  async getFrames(id: string, signal?: AbortSignal): Promise<FramesPayload> {
    checkAbort(signal);
    return this.framesPayload(id);
  }

  async listModels() {
    return fixtureModels(this.descriptorIndex().size);
  }

  async findSimilar(req: SimilarRequest, signal?: AbortSignal): Promise<SimilarResult> {
    checkAbort(signal);
    const t0 = performance.now();
    const index = this.descriptorIndex();
    const src = index.get(req.play_id);
    if (!src) throw new ApiError("This play has no snap event, so the formation descriptor is undefined and retrieval cannot run.", 422, "user");
    const ranked = [...index.entries()]
      .filter(([id]) => id !== req.play_id)
      .map(([id, v]) => ({ id, score: cosineSimilarity(src, v) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, req.k);
    return {
      request_id: nextRequestId("fx-sim"),
      source_play_id: req.play_id,
      model_version: DESCRIPTOR_MODEL,
      model_kind: "baseline",
      scope: {
        description: `Fixture corpus · ${index.size} of ${DATASET.play_count} plays indexed · exact search`,
        corpus_size: index.size,
        index: "exact",
        self_match_excluded: true,
      },
      results: ranked.map((r, i) => ({ rank: i + 1, score: r.score, play: this.play(r.id).summary })),
      latency_ms: performance.now() - t0,
    };
  }

  async compare(left: string, right: string, signal?: AbortSignal): Promise<CompareResult> {
    checkAbort(signal);
    const l = this.series(left);
    const r = this.series(right);
    const index = this.descriptorIndex();
    const a = index.get(left);
    const b = index.get(right);
    return {
      request_id: nextRequestId("fx-cmp"),
      left_play_id: left,
      right_play_id: right,
      similarity: a && b ? { score: cosineSimilarity(a, b), model_version: DESCRIPTOR_MODEL, model_kind: "baseline" } : null,
      similarity_unavailable_reason: a && b ? null : "One or both plays have no snap event, so the formation descriptor is undefined.",
      window: "Snap to +3.0 s, snap-relative",
      measures: compareMeasures(l, r),
      correspondence: snapCorrespondence(l, r),
      source: "Computed in the browser from fixture tracking frames",
    };
  }

  async predictTrajectory(req: TrajectoryRequest, signal?: AbortSignal): Promise<TrajectoryPrediction> {
    checkAbort(signal);
    const series = this.series(req.play_id);
    const o = series.frameIds.indexOf(req.origin_frame_id);
    if (o < 0) throw new ApiError(`Frame ${req.origin_frame_id} is not in this play.`, 422, "user");
    const problem = cvOriginProblem(series, o);
    if (problem) throw new ApiError(problem, 422, "user");
    if (!CV_HORIZONS.includes(req.horizon_s)) throw new ApiError(`Horizon ${req.horizon_s} s is not supported.`, 422, "user");
    const { players, step, latency } = cvPredict(series, o, req.horizon_s, req.player_ids);
    return {
      request_id: nextRequestId("fx-traj"),
      play_id: req.play_id,
      model_version: CV_MODEL,
      origin_frame_id: req.origin_frame_id,
      input_window: { start_frame_id: series.frameIds[o - 1], end_frame_id: series.frameIds[o] },
      horizon_s: req.horizon_s,
      step_s: step,
      players,
      uncertainty: {
        kind: "samples",
        calibration: "uncalibrated",
        description: "24 sampled futures from assumed velocity noise (heading σ 12°, speed σ 15%). Nominal; not calibrated against observed outcomes.",
      },
      latency_ms: latency,
      latency_scope: "Model only, in-browser fixture",
      warnings: [],
    };
  }

  async getPlayLabConfig(id: string, signal?: AbortSignal) {
    checkAbort(signal);
    return playLabConfig(this.detail(id), this.series(id));
  }

  async runCounterfactual(req: CounterfactualRequest, signal?: AbortSignal): Promise<CounterfactualResult> {
    checkAbort(signal);
    const series = this.series(req.play_id);
    const config = playLabConfig(this.detail(req.play_id), series);
    if (config.model_version !== req.model_version) throw new ApiError("Model version changed; reload PlayLab.", 409, "user");
    if (config.editable_frame_id !== req.editable_frame_id) throw new ApiError("Editable frame does not match the model configuration.", 422, "user");
    const r = mockCounterfactual(series, config, req.player_id, { x: req.x, y: req.y });
    return {
      request_id: nextRequestId("fx-cf"),
      play_id: req.play_id,
      model_version: config.model_version!,
      model_kind: "mock",
      editable_frame_id: config.editable_frame_id!,
      input_window: config.input_window!,
      horizon_s: config.horizon_s!,
      step_s: config.step_s!,
      modification: { player_id: req.player_id, original: r.originalPosition, modified: { x: req.x, y: req.y } },
      original: r.original,
      modified: r.modified,
      uncertainty: { kind: "none", calibration: null, description: "The development mock produces no uncertainty." },
      measures: r.measures,
      warnings: r.warnings,
      latency_ms: r.latency,
    };
  }

  async getEvaluation(modelVersion: string): Promise<EvaluationReport> {
    const model = fixtureModels(0).find((m) => m.model_version === modelVersion);
    const empty = {
      model_version: modelVersion,
      run_id: null,
      run_time: null,
      dataset_version: null,
      split: null,
      artifact_uri: null,
      scope: null,
      trajectory: null,
      error_by_horizon: null,
      uncertainty: null,
      retrieval: null,
      system: null,
      slices: null,
      failure_modes: [],
      reproducibility: null,
    };
    if (!model) return { ...empty, task: "unknown", status: "unavailable", status_reason: `No model named ${modelVersion} is registered.` };
    return {
      ...empty,
      task: model.task,
      status: model.kind === "mock" ? "unavailable" : "pending",
      status_reason:
        model.kind === "mock"
          ? "Development mocks are never evaluated. This model exists only to exercise the PlayLab interface."
          : "No evaluation run is recorded for this model. Fixture models are not evaluated on synthetic plays, so no metrics are reported.",
    };
  }
}

function round(v: number, d: number) {
  const f = 10 ** d;
  return Math.round(v * f) / f;
}

