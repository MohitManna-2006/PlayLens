/**
 * In-browser implementation of the /api/v1 contract over synthetic plays, for
 * interface development and tests. Enabled only with
 * NEXT_PUBLIC_PLAYLENS_DATA_SOURCE=fixture; the PlayLens API is the default.
 * See docs/decisions/ADR-0001-web-fixture-data-source.md and ADR-0002.
 */
import type {
  ComparePlay,
  CompareRequest,
  CompareResponse,
  CounterfactualRequest,
  CounterfactualResult,
  DatasetStatus,
  EvaluationReport,
  Facets,
  FramesPayload,
  PlayDetail,
  PlayPage,
  Evidence,
  PlayQuery,
  PlaySummary,
  SimilarityFilters,
  SimilarityRequest,
  SimilaritySearchResponse,
  TrajectoryPrediction,
  TrajectoryRequest,
} from "@/lib/contracts";
import { ApiError, SCHEMA_VERSION } from "@/lib/contracts";
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
  dataset: "playlens_fixture",
  title: "PlayLens procedural fixture",
  source: "PlayLens procedural fixture (synthetic)",
  subset: null,
  dataset_version: "fixture-v2",
  schema_version: SCHEMA_VERSION,
  play_count: GAME_COUNT * PLAYS_PER_GAME,
  synthetic: true,
  license_note: "Synthetic plays generated in the browser. Not NFL data.",
  generated_at: null,
};
const EMPTY_FILTERS: SimilarityFilters = {
  down: null,
  yards_to_go_min: null,
  yards_to_go_max: null,
  quarter: null,
  week_min: null,
  week_max: null,
  offense: null,
  defense: null,
  offense_formation: null,
  field_position_min: null,
  field_position_max: null,
  splits: null,
};
const COORDINATES = "Canonical yards: x 0–120 including end zones, y 0–53.3, offense attacks +x; angles NGS (0° = +y, clockwise)";

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
      for (const p of out) this.byId.set(p.summary.id, p);
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
    const d: PlayDetail = {
      ...p.summary,
      players: p.refs,
      events: p.events.filter((e) => !p.missing.has(e.index)).map((e) => ({ frame_id: e.index + 1, event: e.event })),
      play_direction: p.direction,
      line_of_scrimmage_x: p.los,
      first_down_x: p.firstDown,
      frame_rate_hz: FRAME_RATE,
      ball_landing: null,
      coordinates: {
        system: "playlens-canonical-v1",
        description: COORDINATES,
        raw_play_direction: p.direction,
        raw_transform: p.direction === "left" ? "rotate_180" : "identity",
      },
      provenance: {
        source: DATASET.source!,
        dataset: DATASET.dataset!,
        dataset_version: DATASET.dataset_version!,
        schema_version: SCHEMA_VERSION,
        coordinate_convention: COORDINATES,
        synthetic: true,
        subset: null,
      },
    };
    this.details.set(id, d);
    return d;
  }

  private framesPayload(id: string): FramesPayload {
    const cached = this.frames.get(id);
    if (cached) return cached;
    const p = this.play(id);
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
        players.push({
          player_id: p.refs[j].player_id,
          x: round(xs[i] + rng.normal(0, 0.02), 2),
          y: round(ys[i] + rng.normal(0, 0.02), 2),
          s: round(s, 2),
          a: round(acc, 2),
          dir: round(lastDir[j], 1),
          o: round(lastDir[j], 1),
        });
      }
      const ball = p.special === "no_ball" ? null : { x: p.ballX[i], y: p.ballY[i] };
      frames.push({
        frame_id: i + 1,
        frame_index: i,
        time_s: round(i * dt, 3),
        ball: ball ? { x: round(ball.x, 2), y: round(ball.y, 2) } : null,
        players,
      });
    }
    const payload: FramesPayload = {
      id,
      dataset_version: DATASET.dataset_version!,
      schema_version: SCHEMA_VERSION,
      coordinate_system: "playlens-canonical-v1",
      frame_rate_hz: FRAME_RATE,
      observed_frame_count: frames.length,
      frames,
    };
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
        const v = formationDescriptor(this.series(p.summary.id));
        if (v) raw.set(p.summary.id, v);
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
          const hay = [s.id, s.home_team, s.away_team, s.offense, s.defense, s.description]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();
          if (!hay.includes(needle)) return false;
        }
        if (q.season !== undefined && s.season !== q.season) return false;
        if (q.week !== undefined && s.week !== q.week) return false;
        if (q.formation && s.context.offense_formation !== q.formation) return false;
        if (q.coverage && s.annotations.coverage_type !== q.coverage) return false;
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
          const o = s.outcome.yards_gained;
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
      items = items.filter((s) => s.id !== q.similar_to && index.has(s.id));
      for (const s of items) scores[s.id] = cosineSimilarity(src, index.get(s.id)!);
      items.sort((a, b) => scores[b.id] - scores[a.id]);
      similarity = { source_play_id: q.similar_to, model_version: DESCRIPTOR_MODEL, scores };
    } else {
      items.sort((a, b) => (b.game_date ?? "").localeCompare(a.game_date ?? "") || a.play_id - b.play_id);
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
        ? { ...similarity, scores: Object.fromEntries(items.slice(start, start + q.page_size).map((s) => [s.id, similarity!.scores[s.id]])) }
        : null,
      dataset: DATASET,
    };
  }

  async getFacets(): Promise<Facets> {
    const all = this.all().map((p) => p.summary);
    return {
      seasons: [...new Set(all.map((s) => s.season).filter((s): s is number => s !== null))].sort((a, b) => b - a),
      weeks: [...new Set(all.map((s) => s.week).filter((w): w is number => w !== null))].sort((a, b) => a - b),
      teams: [...TEAMS],
      formations: [],
      coverages: [],
      play_types: ["pass", "run"],
      quarters: [1, 2, 3, 4],
    };
  }

  async getDataset(): Promise<DatasetStatus> {
    return DATASET;
  }

  async getFuture(id: string): Promise<never> {
    this.play(id);
    throw new ApiError("The synthetic fixture has no held-out future trajectories.", null, "unavailable", "not_served");
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

  /**
   * Fixture similarity: the handcrafted formation descriptor (a baseline, not a
   * learned embedding) with exact cosine search over synthetic plays. Responses
   * say so (`representation: "baseline_descriptor"`, `backend: "memory"`).
   */
  async findSimilar(req: SimilarityRequest, signal?: AbortSignal): Promise<SimilaritySearchResponse> {
    checkAbort(signal);
    const t0 = performance.now();
    const index = this.descriptorIndex();
    const src = index.get(req.play_id);
    const query = this.play(req.play_id).summary;
    if (!src) throw new ApiError("This play has no snap event, so the formation descriptor is undefined and retrieval cannot run.", 404, "user", "embedding_unavailable");
    const f = { ...EMPTY_FILTERS, ...req.filters };
    const keep = (s: PlaySummary) =>
      (f.down === null || s.down === f.down) &&
      (f.yards_to_go_min === null || (s.yards_to_go ?? -1) >= f.yards_to_go_min) &&
      (f.yards_to_go_max === null || (s.yards_to_go ?? 1e9) <= f.yards_to_go_max) &&
      (f.quarter === null || s.quarter === f.quarter) &&
      (f.week_min === null || (s.week ?? -1) >= f.week_min) &&
      (f.week_max === null || (s.week ?? 1e9) <= f.week_max) &&
      (f.offense === null || s.offense === f.offense) &&
      (f.defense === null || s.defense === f.defense) &&
      (f.offense_formation === null || s.context.offense_formation === f.offense_formation) &&
      f.splits === null; // fixture plays have no temporal split
    const eligible = [...index.entries()].filter(([id]) => id !== req.play_id && keep(this.play(id).summary));
    const ranked = eligible
      .map(([id, v]) => ({ id, score: cosineSimilarity(src, v) }))
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, req.k);
    const ms = performance.now() - t0;
    return {
      request_id: nextRequestId("fx-sim"),
      query: { play_id: req.play_id, split: "unknown", model_version: DESCRIPTOR_MODEL, k: req.k, mode: "exact", filters: f },
      results: ranked.map((r, i) => {
        const other = this.play(r.id).summary;
        return {
          rank: i + 1,
          play_id: r.id,
          cosine_distance: 1 - r.score,
          cosine_similarity: r.score,
          split: "unknown",
          play: other,
          evidence: this.evidence(r.id, req.play_id, r.id, query, other),
        };
      }),
      retrieval: {
        mode: req.mode ?? "approximate",
        plan: "exact_scan",
        metric: "cosine",
        representation: "baseline_descriptor",
        backend: "memory",
        model_version: DESCRIPTOR_MODEL,
        dataset_version: DATASET.dataset_version!,
        split_version: "none (synthetic fixture)",
        embedding_dimension: src.length,
        normalization: "L2-normalised",
        corpus_size: index.size,
        candidates: eligible.length,
        self_match_excluded: true,
        hnsw: null,
        cosine_reference: null,
        latency_ms: ms,
        database_ms: ms,
        search_ms: ms,
      },
      warnings: eligible.length < req.k ? [`Only ${eligible.length} plays match these filters.`] : [],
      evidence_note: "Synthetic fixture: a handcrafted descriptor baseline, not a learned embedding.",
    };
  }

  private evidence(scope: string, leftId: string, rightId: string, l: PlaySummary, r: PlaySummary): Evidence[] {
    const meta = (key: string, label: string, a: number | null, b: number | null, unit: string | null): Evidence => ({
      id: `${scope}.metadata.${key}`,
      kind: "metadata",
      source: "pre_snap_context",
      label,
      left_value: a,
      right_value: b,
      left_text: null,
      right_text: null,
      unit,
      decimals: 0,
      delta: a !== null && b !== null ? b - a : null,
      relation: a === null || b === null ? "unavailable" : a === b ? "same" : "different",
      definition: `${label} as generated by the fixture.`,
      missing_reason: a === null || b === null ? "Not generated for one or both plays." : null,
      frame_reference: null,
    });
    const structural = compareMeasures(this.series(leftId), this.series(rightId)).map(
      (m): Evidence => ({
        id: `${scope}.structure.${m.key}`,
        kind: "structural_metric",
        source: "tracking",
        label: m.label,
        left_value: m.left,
        right_value: m.right,
        left_text: null,
        right_text: null,
        unit: m.unit,
        decimals: m.decimals,
        delta: m.left !== null && m.right !== null ? m.right - m.left : null,
        relation: null,
        definition: m.definition,
        missing_reason: m.missing_reason,
        frame_reference: null,
      }),
    );
    return [
      meta("down", "Down", l.down, r.down, null),
      meta("yards_to_go", "Yards to go", l.yards_to_go, r.yards_to_go, "yd"),
      meta("quarter", "Quarter", l.quarter, r.quarter, null),
      ...structural,
    ];
  }

  async compare(req: CompareRequest, signal?: AbortSignal): Promise<CompareResponse> {
    checkAbort(signal);
    const t0 = performance.now();
    const { left_play_id: left, right_play_id: right } = req;
    if (left === right) throw new ApiError("Choose two different plays to compare.", 422, "user", "invalid_comparison");
    const l = this.series(left);
    const r = this.series(right);
    const index = this.descriptorIndex();
    const a = index.get(left);
    const b = index.get(right);
    const rank = (q: Float64Array, qid: string, d: number) =>
      1 + [...index.entries()].filter(([id, v]) => id !== qid && 1 - cosineSimilarity(q, v) < d).length;
    const side = (id: string, s: TrackingSeries): ComparePlay => ({
      play_id: id,
      play: this.play(id).summary,
      split: "unknown",
      observed_frame_count: s.frameIds.length,
      first_frame_id: s.frameIds[0],
      last_frame_id: s.frameIds[s.frameIds.length - 1],
      window_start_frame_id: null,
    });
    const score = a && b ? cosineSimilarity(a, b) : null;
    return {
      request_id: nextRequestId("fx-cmp"),
      left: side(left, l),
      right: side(right, r),
      similarity:
        a && b && score !== null
          ? {
              representation: "baseline_descriptor",
              model_version: DESCRIPTOR_MODEL,
              dataset_version: DATASET.dataset_version!,
              split_version: "none (synthetic fixture)",
              cosine_similarity: score,
              cosine_distance: 1 - score,
              right_rank_from_left: rank(a, left, 1 - score),
              left_rank_from_right: rank(b, right, 1 - score),
              rank_pool: index.size - 1,
              cosine_reference: null,
            }
          : null,
      similarity_unavailable_reason: a && b ? null : "One or both plays have no snap event, so the formation descriptor is undefined.",
      similarity_unavailable_code: a && b ? null : "embedding_unavailable",
      evidence: this.evidence("comparison", left, right, this.play(left).summary, this.play(right).summary),
      correspondence: snapCorrespondence(l, r),
      descriptor_version: "fixture-snap-window",
      dataset_version: DATASET.dataset_version!,
      latency_ms: performance.now() - t0,
      warnings: [],
      evidence_note: "Synthetic fixture: measures computed in the browser from fixture tracking frames.",
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
      model_name: "cv-baseline",
      model_version: CV_MODEL,
      dataset_version: DATASET.dataset_version!,
      split_version: "none (fixture models are not trained)",
      play_split: "unknown",
      origin_frame_id: req.origin_frame_id,
      input_window: { start_frame_id: series.frameIds[o - 1], end_frame_id: series.frameIds[o] },
      horizon_s: req.horizon_s,
      step_s: step,
      future_frame_ids: Array.from({ length: Math.round(req.horizon_s / step) }, (_, k) => series.frameIds[o] + k + 1),
      target_horizon_frames: null,
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

