/**
 * Web ⇄ API contract (Masterbrain §21, C01), mirrored from the Pydantic models
 * in services/api/src/playlens_api/schemas. Every payload that crosses the
 * boundary is parsed with these schemas, including the development fixture, so
 * neither source can drift from the other unnoticed.
 *
 * Identity: a play resource's `id` is the PlayLens play ID "<game_id>-<play_id>"
 * (lib/playId). `game_id` and `play_id` are the NFL natural key; `play_id` alone
 * repeats across games. Requests for model features (trajectory, similarity,
 * PlayLab) name the PlayLens ID `play_id`.
 *
 * Coordinates are CANONICAL yards: x ∈ [0, 120] along the long axis including
 * both end zones, y ∈ [0, 53⅓] across the field, and the offense always attacks
 * toward +x. Plays recorded moving left were rotated 180° during preprocessing;
 * `play_direction` keeps the recorded direction so the Source view can undo it.
 * Angles: degrees, 0° = +y, clockwise (Next Gen Stats convention).
 */
import { z } from "zod";

export const SCHEMA_VERSION = "2";

const nullableNumber = z.number().nullable();
const nullableInt = z.number().int().nullable();
const nullableString = z.string().nullable();

export const PlaySideSchema = z.enum(["offense", "defense"]);
export type PlaySide = z.infer<typeof PlaySideSchema>;

export const PlayDirectionSchema = z.enum(["left", "right"]);
export type PlayDirection = z.infer<typeof PlayDirectionSchema>;

export const PlayTypeSchema = z.enum(["pass", "run", "other"]);
export type PlayType = z.infer<typeof PlayTypeSchema>;

export const ProvenanceSchema = z.object({
  source: z.string(),
  dataset: z.string(),
  dataset_version: z.string(),
  schema_version: z.string(),
  coordinate_convention: z.string(),
  synthetic: z.boolean(),
  subset: nullableString,
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

/** Known before the snap. */
export const PlayContextSchema = z.object({
  offense_formation: nullableString,
  receiver_alignment: nullableString,
  defenders_in_the_box: nullableInt,
  home_score: nullableInt,
  visitor_score: nullableInt,
  home_win_probability: nullableNumber,
  visitor_win_probability: nullableNumber,
  expected_points: nullableNumber,
});
export type PlayContext = z.infer<typeof PlayContextSchema>;

/** Charted labels describing what happened during the play; not pre-snap information. */
export const PlayAnnotationsSchema = z.object({
  coverage_family: nullableString,
  coverage_type: nullableString,
  target_route: nullableString,
  play_action: z.boolean().nullable(),
  dropback_type: nullableString,
  dropback_distance: nullableNumber,
  pass_location_type: nullableString,
});
export type PlayAnnotations = z.infer<typeof PlayAnnotationsSchema>;

/** Post-play results. Descriptive only. */
export const PlayOutcomeSchema = z.object({
  pass_result: nullableString,
  pass_length: nullableInt,
  yards_gained: nullableInt,
  pre_penalty_yards_gained: nullableInt,
  penalty_yards: nullableInt,
  nullified_by_penalty: z.boolean().nullable(),
  expected_points_added: nullableNumber,
  home_win_probability_added: nullableNumber,
  visitor_win_probability_added: nullableNumber,
});
export type PlayOutcome = z.infer<typeof PlayOutcomeSchema>;

export const TrackingSummarySchema = z.object({
  observed_frame_count: z.number().int(),
  observed_duration_s: z.number(),
  first_frame_id: z.number().int(),
  last_frame_id: z.number().int(),
  player_count: z.number().int(),
  offense_player_count: z.number().int(),
  defense_player_count: z.number().int(),
  predicted_player_count: z.number().int(),
  future_frame_count: z.number().int(),
  future_duration_s: z.number(),
  ball_tracked: z.boolean(),
});
export type TrackingSummary = z.infer<typeof TrackingSummarySchema>;

export const PlaySummarySchema = z.object({
  id: z.string(),
  game_id: z.number().int(),
  play_id: z.number().int(),
  season: nullableInt,
  week: nullableInt,
  game_date: nullableString,
  home_team: z.string(),
  away_team: z.string(),
  offense: nullableString,
  defense: nullableString,
  quarter: nullableInt,
  game_clock: nullableString,
  down: z.number().int().min(1).max(4).nullable(),
  yards_to_go: nullableInt,
  yardline_label: nullableString,
  play_type: PlayTypeSchema.nullable(),
  /** Supplied narrative; it describes the result, so it is post-play text. */
  description: nullableString,
  context: PlayContextSchema,
  annotations: PlayAnnotationsSchema,
  outcome: PlayOutcomeSchema,
  tracking: TrackingSummarySchema,
});
export type PlaySummary = z.infer<typeof PlaySummarySchema>;

export const PlayerRefSchema = z.object({
  player_id: z.string(),
  nfl_id: nullableInt,
  jersey: nullableString,
  name: nullableString,
  side: PlaySideSchema,
  position: nullableString,
  role: nullableString,
  /** Has a held-out future trajectory (dataset flag player_to_predict). */
  player_to_predict: z.boolean(),
});
export type PlayerRef = z.infer<typeof PlayerRefSchema>;

export const PlayEventSchema = z.object({
  frame_id: z.number().int(),
  event: z.string(),
});
export type PlayEvent = z.infer<typeof PlayEventSchema>;

/** Where the pass lands: one point, not a ball track. */
export const BallLandingSchema = z.object({
  x: z.number(),
  y: z.number(),
  x_raw: z.number(),
  y_raw: z.number(),
  in_field: z.boolean(),
});
export type BallLanding = z.infer<typeof BallLandingSchema>;

export const CoordinateInfoSchema = z.object({
  system: z.string(),
  description: z.string(),
  raw_play_direction: PlayDirectionSchema.nullable(),
  raw_transform: z.enum(["identity", "rotate_180"]),
});

export const PlayDetailSchema = PlaySummarySchema.extend({
  players: z.array(PlayerRefSchema),
  events: z.array(PlayEventSchema),
  /** Recorded attack direction. Coordinates are already canonical. */
  play_direction: PlayDirectionSchema.nullable(),
  line_of_scrimmage_x: nullableNumber,
  first_down_x: nullableNumber,
  frame_rate_hz: z.number().positive(),
  ball_landing: BallLandingSchema.nullable(),
  coordinates: CoordinateInfoSchema,
  provenance: ProvenanceSchema,
});
export type PlayDetail = z.infer<typeof PlayDetailSchema>;

export const FramePlayerSchema = z.object({
  player_id: z.string(),
  x: z.number(),
  y: z.number(),
  s: nullableNumber,
  a: nullableNumber,
  dir: nullableNumber,
  o: nullableNumber,
});

export const FrameSchema = z.object({
  frame_id: z.number().int(),
  frame_index: z.number().int(),
  time_s: z.number(),
  ball: z.object({ x: z.number(), y: z.number() }).nullable(),
  players: z.array(FramePlayerSchema),
});

/** Observed tracking only; never contains held-out future positions. */
export const FramesPayloadSchema = z.object({
  id: z.string(),
  dataset_version: z.string(),
  schema_version: z.string(),
  coordinate_system: z.string(),
  frame_rate_hz: z.number().positive(),
  observed_frame_count: z.number().int(),
  frames: z.array(FrameSchema),
});
export type FramesPayload = z.infer<typeof FramesPayloadSchema>;

/** Held-out actual future positions from the dataset. Ground truth, not a prediction. */
export const FuturePayloadSchema = z.object({
  id: z.string(),
  kind: z.literal("actual_future"),
  description: z.string(),
  dataset_version: z.string(),
  schema_version: z.string(),
  coordinate_system: z.string(),
  frame_rate_hz: z.number().positive(),
  origin_frame_id: z.number().int(),
  origin_time_s: z.number(),
  horizon_frames: z.number().int(),
  horizon_s: z.number(),
  trajectories: z.array(
    z.object({
      player_id: z.string(),
      points: z.array(
        z.object({
          frame_id: z.number().int(),
          frame_index: z.number().int(),
          time_s: z.number(),
          x: z.number(),
          y: z.number(),
        }),
      ),
    }),
  ),
});
export type FuturePayload = z.infer<typeof FuturePayloadSchema>;

export const PlaySortSchema = z.enum(["recent", "similarity"]);
export type PlaySort = z.infer<typeof PlaySortSchema>;

export const DistanceBandSchema = z.enum(["short", "medium", "long"]);
export type DistanceBand = z.infer<typeof DistanceBandSchema>;

export const OutcomeFilterSchema = z.enum(["gain", "no_gain", "loss", "unknown"]);
export type OutcomeFilter = z.infer<typeof OutcomeFilterSchema>;

export interface PlayQuery {
  q?: string;
  season?: number;
  week?: number;
  offense?: string;
  defense?: string;
  formation?: string;
  coverage?: string;
  down?: number;
  distance?: DistanceBand;
  play_type?: PlayType;
  quarter?: number;
  outcome?: OutcomeFilter;
  sort: PlaySort;
  similar_to?: string;
  page: number;
  page_size: number;
}

export const DatasetStatusSchema = z.object({
  dataset: nullableString,
  title: nullableString,
  source: nullableString,
  subset: nullableString,
  dataset_version: nullableString,
  schema_version: nullableString,
  play_count: z.number().int(),
  synthetic: z.boolean(),
  license_note: nullableString,
  generated_at: nullableString,
});
export type DatasetStatus = z.infer<typeof DatasetStatusSchema>;

export const PlayPageSchema = z.object({
  items: z.array(PlaySummarySchema),
  total: z.number().int(),
  page: z.number().int(),
  page_size: z.number().int(),
  sort: PlaySortSchema,
  similarity: z
    .object({
      source_play_id: z.string(),
      model_version: z.string(),
      scores: z.record(z.string(), z.number()),
    })
    .nullable(),
  dataset: DatasetStatusSchema,
});
export type PlayPage = z.infer<typeof PlayPageSchema>;

export const FacetsSchema = z.object({
  seasons: z.array(z.number().int()),
  weeks: z.array(z.number().int()),
  teams: z.array(z.string()),
  formations: z.array(z.string()),
  coverages: z.array(z.string()),
  play_types: z.array(PlayTypeSchema),
  quarters: z.array(z.number().int()),
});
export type Facets = z.infer<typeof FacetsSchema>;

/* ---------- Models ---------- */

export const ModelKindSchema = z.enum(["learned", "baseline", "mock"]);
export type ModelKind = z.infer<typeof ModelKindSchema>;

export const UncertaintyKindSchema = z.enum(["none", "samples", "gaussian"]);
export type UncertaintyKind = z.infer<typeof UncertaintyKindSchema>;

export const CalibrationStatusSchema = z.enum(["nominal", "empirical", "uncalibrated"]);
export type CalibrationStatus = z.infer<typeof CalibrationStatusSchema>;

export const ModelInfoSchema = z.object({
  model_version: z.string(),
  task: z.enum(["trajectory", "retrieval", "counterfactual"]),
  kind: ModelKindSchema,
  name: z.string(),
  description: z.string(),
  served: z.boolean(),
  evaluation_status: z.enum(["evaluated", "pending", "unavailable"]),
  trajectory: z
    .object({
      horizons_s: z.array(z.number().positive()),
      input_window_frames: z.number().int().positive(),
      uncertainty: UncertaintyKindSchema,
      uncertainty_note: z.string().nullable(),
      origin_rule: z.string(),
      origin_after_snap: z.boolean(),
      /** any_frame: the user pins the origin. last_observed_frame: forecasts start where observation ends. */
      origin: z.enum(["any_frame", "last_observed_frame"]),
    })
    .nullable(),
  retrieval: z
    .object({
      representation: z.string(),
      distance: z.literal("cosine"),
      index: z.enum(["exact", "hnsw"]),
      corpus_size: z.number().int(),
    })
    .nullable(),
  provenance: z
    .object({
      model_name: z.string(),
      run_id: z.string().nullable(),
      mlflow_run_id: z.string().nullable(),
      dataset_version: z.string(),
      split_version: z.string(),
      created_at: z.string().nullable(),
      parameters: z.number().int(),
      weights_bytes: z.number().int(),
      git_commit: z.string().nullable(),
    })
    .nullable(),
  /** Recorded held-out metrics, next to the constant-velocity baseline on the same players. */
  metrics: z.array(
    z.object({
      split: z.enum(["validation", "test"]),
      ade_yd: z.number(),
      fde_yd: z.number(),
      players: z.number().int(),
      baseline_model_version: z.string(),
      baseline_ade_yd: z.number(),
      baseline_fde_yd: z.number(),
    }),
  ),
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/* ---------- Trajectory prediction ---------- */

export const PathPointSchema = z.object({ x: z.number(), y: z.number() });
export type PathPoint = z.infer<typeof PathPointSchema>;

export const PredictedPlayerSchema = z.object({
  player_id: z.string(),
  /** Positions at origin + (k+1)·step_s, canonical coordinates. */
  path: z.array(PathPointSchema),
  /** True where the play supplies an actual position for comparison (real data) or the model is valid (fixture). */
  valid: z.array(z.boolean()),
  /** Discrete sampled futures, each aligned with `path`. Present only when uncertainty.kind === "samples". */
  samples: z.array(z.array(PathPointSchema)).nullable(),
});
export type PredictedPlayer = z.infer<typeof PredictedPlayerSchema>;

export const TrajectoryUncertaintySchema = z.object({
  kind: UncertaintyKindSchema,
  calibration: CalibrationStatusSchema.nullable(),
  description: z.string().nullable(),
});

export const TrajectoryRequestSchema = z.object({
  play_id: z.string(),
  model_version: z.string().nullable().optional(),
  origin_frame_id: z.number().int(),
  horizon_s: z.number().positive(),
  player_ids: z.array(z.string()).nullable(),
});
export type TrajectoryRequest = z.infer<typeof TrajectoryRequestSchema>;

export const TrajectoryPredictionSchema = z.object({
  request_id: z.string(),
  play_id: z.string(),
  model_name: z.string(),
  model_version: z.string(),
  dataset_version: z.string(),
  split_version: z.string(),
  /** Partition of this play's game when the model was trained; "train" means the model saw it. */
  play_split: z.enum(["train", "validation", "test", "unknown"]),
  origin_frame_id: z.number().int(),
  input_window: z.object({ start_frame_id: z.number().int(), end_frame_id: z.number().int() }),
  horizon_s: z.number(),
  step_s: z.number().positive(),
  /** Frame identifier of each predicted step: output-file frame_id (real data) or tracking frame_id (fixture). */
  future_frame_ids: z.array(z.number().int()),
  /** Future frames the dataset supplies for this play, when known. */
  target_horizon_frames: z.number().int().nullable(),
  players: z.array(PredictedPlayerSchema),
  uncertainty: TrajectoryUncertaintySchema,
  latency_ms: z.number(),
  latency_scope: z.string(),
  warnings: z.array(z.string()),
});
export type TrajectoryPrediction = z.infer<typeof TrajectoryPredictionSchema>;

/* ---------- Similarity and compare ---------- */

/**
 * Similar plays come from POST /api/v1/search/similar: nearest neighbours by
 * cosine distance between learned play embeddings, in PostgreSQL + pgvector.
 * Cosine similarity is not a probability or a percentage; the embedding space is
 * anisotropic, so responses carry the space's own reference distribution.
 */
export const RetrievalModeSchema = z.enum(["exact", "approximate"]);
export type RetrievalMode = z.infer<typeof RetrievalModeSchema>;

export const SplitSchema = z.enum(["train", "validation", "test"]);
export type Split = z.infer<typeof SplitSchema>;
/** Split of a retrieved or compared play; "unknown" only from the synthetic fixture. */
export const PlaySplitSchema = z.enum(["train", "validation", "test", "unknown"]);
export type PlaySplit = z.infer<typeof PlaySplitSchema>;

/** Filters run inside the database query. Pre-snap context and split only. */
export const SimilarityFiltersSchema = z.object({
  down: nullableInt,
  yards_to_go_min: nullableInt,
  yards_to_go_max: nullableInt,
  quarter: nullableInt,
  week_min: nullableInt,
  week_max: nullableInt,
  offense: nullableString,
  defense: nullableString,
  offense_formation: nullableString,
  field_position_min: nullableNumber,
  field_position_max: nullableNumber,
  splits: z.array(SplitSchema).nullable(),
});
export type SimilarityFilters = z.infer<typeof SimilarityFiltersSchema>;

export interface SimilarityRequest {
  play_id: string;
  k: number;
  mode?: RetrievalMode;
  model_version?: string | null;
  filters?: Partial<SimilarityFilters>;
}

/** One observation about both plays. In search results `left` is the query play. */
export const EvidenceSchema = z.object({
  id: z.string(),
  kind: z.enum(["metadata", "structural_metric"]),
  source: z.enum(["pre_snap_context", "charted_label", "tracking"]),
  label: z.string(),
  left_value: nullableNumber,
  right_value: nullableNumber,
  left_text: nullableString,
  right_text: nullableString,
  unit: nullableString,
  decimals: z.number().int().min(0).max(3),
  delta: nullableNumber,
  relation: z.enum(["same", "different", "unavailable"]).nullable(),
  definition: z.string(),
  missing_reason: nullableString,
  frame_reference: z
    .object({
      anchor: z.enum(["last_observed_frame", "last_2s_window"]),
      left_frame_ids: z.array(z.number().int()),
      right_frame_ids: z.array(z.number().int()),
    })
    .nullable(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const CosineReferenceSchema = z.object({
  random_pair_mean: z.number(),
  random_pair_p50: z.number(),
  random_pair_p95: z.number(),
  nearest_neighbor_p05: z.number(),
  nearest_neighbor_p50: z.number(),
  nearest_neighbor_p95: z.number(),
  description: z.string(),
});
export type CosineReference = z.infer<typeof CosineReferenceSchema>;

export const RetrievalProvenanceSchema = z.object({
  mode: RetrievalModeSchema,
  /** What the database executed; approximate requests can run exactly under selective filters. */
  plan: z.enum(["hnsw_index_scan", "exact_scan"]),
  metric: z.literal("cosine"),
  representation: z.enum(["learned_embedding", "baseline_descriptor"]),
  backend: z.enum(["pgvector", "memory"]),
  model_version: z.string(),
  dataset_version: z.string(),
  split_version: z.string(),
  embedding_dimension: z.number().int(),
  normalization: z.string(),
  corpus_size: z.number().int(),
  candidates: z.number().int(),
  self_match_excluded: z.boolean(),
  hnsw: z
    .object({
      index: z.string(),
      m: nullableInt,
      ef_construction: nullableInt,
      ef_search: z.number().int(),
      iterative_scan: z.string(),
      max_scan_tuples: nullableInt,
    })
    .nullable(),
  cosine_reference: CosineReferenceSchema.nullable(),
  latency_ms: z.number(),
  database_ms: z.number(),
  search_ms: z.number(),
});
export type RetrievalProvenance = z.infer<typeof RetrievalProvenanceSchema>;

export const SimilarityResultSchema = z.object({
  rank: z.number().int().min(1),
  play_id: z.string(),
  cosine_distance: z.number(),
  cosine_similarity: z.number(),
  split: PlaySplitSchema,
  play: PlaySummarySchema,
  evidence: z.array(EvidenceSchema),
});
export type SimilarityResult = z.infer<typeof SimilarityResultSchema>;

export const SimilaritySearchResponseSchema = z.object({
  request_id: z.string(),
  query: z.object({
    play_id: z.string(),
    split: PlaySplitSchema,
    model_version: z.string(),
    k: z.number().int(),
    mode: RetrievalModeSchema,
    filters: SimilarityFiltersSchema,
  }),
  results: z.array(SimilarityResultSchema),
  retrieval: RetrievalProvenanceSchema,
  warnings: z.array(z.string()),
  evidence_note: z.string(),
});
export type SimilaritySearchResponse = z.infer<typeof SimilaritySearchResponseSchema>;

export interface CompareRequest {
  left_play_id: string;
  right_play_id: string;
  model_version?: string | null;
}

export const ComparePlaySchema = z.object({
  play_id: z.string(),
  play: PlaySummarySchema,
  split: PlaySplitSchema,
  observed_frame_count: z.number().int(),
  first_frame_id: z.number().int(),
  /** Last observed frame: where the dataset's input window ends (forecast origin). */
  last_frame_id: z.number().int(),
  window_start_frame_id: nullableInt,
});
export type ComparePlay = z.infer<typeof ComparePlaySchema>;

export const CompareResponseSchema = z.object({
  request_id: z.string(),
  left: ComparePlaySchema,
  right: ComparePlaySchema,
  similarity: z
    .object({
      representation: z.enum(["learned_embedding", "baseline_descriptor"]),
      model_version: z.string(),
      dataset_version: z.string(),
      split_version: z.string(),
      cosine_similarity: z.number(),
      cosine_distance: z.number(),
      /** 1 + plays strictly closer to the left play than the right one (exact). */
      right_rank_from_left: z.number().int(),
      left_rank_from_right: z.number().int(),
      rank_pool: z.number().int(),
      cosine_reference: CosineReferenceSchema.nullable(),
    })
    .nullable(),
  similarity_unavailable_reason: nullableString,
  similarity_unavailable_code: nullableString,
  evidence: z.array(EvidenceSchema),
  correspondence: z
    .object({
      method: z.string(),
      pairs: z.array(z.object({ left_player_id: z.string(), right_player_id: z.string(), basis: z.string() })),
    })
    .nullable(),
  descriptor_version: z.string(),
  dataset_version: z.string(),
  latency_ms: z.number(),
  warnings: z.array(z.string()),
  evidence_note: z.string(),
});
export type CompareResponse = z.infer<typeof CompareResponseSchema>;

/* ---------- PlayLab ---------- */

export const HalfPlaneSchema = z.object({
  /** Allowed when nx·x + ny·y ≥ c, in source coordinates. */
  nx: z.number(),
  ny: z.number(),
  c: z.number(),
  description: z.string(),
});
export type HalfPlane = z.infer<typeof HalfPlaneSchema>;

export const PlayLabConfigSchema = z.object({
  play_id: z.string(),
  available: z.boolean(),
  unavailable_reason: z.string().nullable(),
  model_version: z.string().nullable(),
  model_kind: ModelKindSchema.nullable(),
  model_note: z.string().nullable(),
  editable_frame_id: z.number().int().nullable(),
  input_window: z.object({ start_frame_id: z.number().int(), end_frame_id: z.number().int() }).nullable(),
  horizon_s: z.number().nullable(),
  step_s: z.number().nullable(),
  max_displacement_yd: z.number().nullable(),
  field_bounds: z.object({ x_min: z.number(), x_max: z.number(), y_min: z.number(), y_max: z.number() }),
  constraints: z.array(HalfPlaneSchema),
  eligible_player_ids: z.array(z.string()),
  ood_displacement_yd: z.number().nullable(),
});
export type PlayLabConfig = z.infer<typeof PlayLabConfigSchema>;

export const CounterfactualRequestSchema = z.object({
  play_id: z.string(),
  model_version: z.string(),
  editable_frame_id: z.number().int(),
  player_id: z.string(),
  x: z.number(),
  y: z.number(),
});
export type CounterfactualRequest = z.infer<typeof CounterfactualRequestSchema>;

export const CounterfactualMeasureSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.string(),
  decimals: z.number().int().min(0).max(3),
  original: nullableNumber,
  modified: nullableNumber,
  definition: z.string(),
});
export type CounterfactualMeasure = z.infer<typeof CounterfactualMeasureSchema>;

export const CounterfactualResultSchema = z.object({
  request_id: z.string(),
  play_id: z.string(),
  model_version: z.string(),
  model_kind: ModelKindSchema,
  editable_frame_id: z.number().int(),
  input_window: z.object({ start_frame_id: z.number().int(), end_frame_id: z.number().int() }),
  horizon_s: z.number(),
  step_s: z.number(),
  modification: z.object({
    player_id: z.string(),
    original: PathPointSchema,
    modified: PathPointSchema,
  }),
  original: z.array(PredictedPlayerSchema),
  modified: z.array(PredictedPlayerSchema),
  uncertainty: TrajectoryUncertaintySchema,
  measures: z.array(CounterfactualMeasureSchema),
  warnings: z.array(z.object({ code: z.string(), message: z.string() })),
  latency_ms: z.number(),
});
export type CounterfactualResult = z.infer<typeof CounterfactualResultSchema>;

/* ---------- Evaluation ---------- */

const IntervalSchema = z.object({ lo: z.number(), hi: z.number(), level: z.number() }).nullable();

export const EvaluationReportSchema = z.object({
  model_version: z.string(),
  task: z.string(),
  status: z.enum(["complete", "pending", "unavailable"]),
  status_reason: z.string().nullable(),
  run_id: z.string().nullable(),
  run_time: z.string().nullable(),
  dataset_version: z.string().nullable(),
  split: z.string().nullable(),
  artifact_uri: z.string().nullable(),
  scope: z
    .object({
      predicted: z.string(),
      observation_window: z.string(),
      horizon: z.string(),
      population: z.string(),
      sample_unit: z.string(),
      sample_count: z.number().int(),
      exclusions: z.string(),
      split_policy: z.string(),
      limitations: z.array(z.string()),
    })
    .nullable(),
  trajectory: z
    .object({
      aggregation: z.string(),
      masks: z.string(),
      condition_groups: z.array(
        z.object({
          conditions: z.string(),
          rows: z.array(
            z.object({
              model_version: z.string(),
              label: z.string(),
              is_served: z.boolean(),
              kind: ModelKindSchema,
              ade_yd: nullableNumber,
              fde_yd: nullableNumber,
              ade_interval: IntervalSchema,
              fde_interval: IntervalSchema,
              horizon_s: z.number(),
              n: z.number().int(),
            }),
          ),
        }),
      ),
    })
    .nullable(),
  error_by_horizon: z
    .object({
      definition: z.string(),
      series: z.array(
        z.object({
          model_version: z.string(),
          label: z.string(),
          is_served: z.boolean(),
          points: z.array(
            z.object({ horizon_s: z.number(), value: nullableNumber, lo: nullableNumber, hi: nullableNumber, n: z.number().int() }),
          ),
        }),
      ),
    })
    .nullable(),
  uncertainty: z
    .object({
      calibration: CalibrationStatusSchema.nullable(),
      supported: z.boolean(),
      unsupported_reason: z.string().nullable(),
      definition: z.string(),
      coverage: z.array(z.object({ nominal: z.number(), empirical: nullableNumber, n: z.number().int() })),
    })
    .nullable(),
  retrieval: z
    .object({
      measures: z.array(
        z.object({
          name: z.string(),
          definition: z.string(),
          label_source: z.string(),
          evaluation_set: z.string(),
          sample_unit: z.string(),
          value: nullableNumber,
          decimals: z.number().int(),
          n: z.number().int(),
          kind: z.enum(["relevance", "ann_recall"]),
        }),
      ),
      examples: z.array(
        z.object({
          query_play_id: z.string(),
          result_play_id: z.string(),
          rank: z.number().int(),
          score: z.number(),
          relevance_label: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  system: z
    .object({
      rows: z.array(
        z.object({
          operation: z.string(),
          p50_ms: nullableNumber,
          p95_ms: nullableNumber,
          p99_ms: nullableNumber,
          n: z.number().int(),
        }),
      ),
      conditions: z.object({
        hardware: z.string(),
        dataset_size: z.string(),
        index_size: z.string().nullable(),
        batch_size: z.number().int(),
        warm: z.boolean(),
        timing_scope: z.enum(["model_only", "end_to_end"]),
      }),
    })
    .nullable(),
  slices: z
    .object({
      reporting_rule: z.string(),
      rows: z.array(
        z.object({
          slice: z.string(),
          n: z.number().int(),
          ade_yd: nullableNumber,
          fde_yd: nullableNumber,
          coverage: nullableNumber,
          sufficient: z.boolean(),
          note: z.string().nullable(),
        }),
      ),
    })
    .nullable(),
  failure_modes: z.array(z.string()),
  reproducibility: z
    .object({
      git_commit: z.string().nullable(),
      config: z.string().nullable(),
      dataset_manifest: z.string().nullable(),
      run_id: z.string().nullable(),
      artifacts: z.array(z.string()),
    })
    .nullable(),
});
export type EvaluationReport = z.infer<typeof EvaluationReportSchema>;

/* ---------- Errors ---------- */

/** Error envelope returned by the API for every non-2xx response. */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    status: z.number().int(),
    request_id: z.string().nullable(),
    details: z.record(z.string(), z.unknown()).nullable(),
  }),
});

/**
 * `unavailable` marks a capability the selected source does not serve (for
 * example a model endpoint before any model exists). Screens show it as an
 * unavailable state, not as a failure.
 */
export type ApiErrorKind = "network" | "user" | "server" | "contract" | "unavailable";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly kind: ApiErrorKind,
    readonly code: string | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function isUnavailable(err: unknown): boolean {
  return err instanceof ApiError && err.kind === "unavailable";
}

/** The retrieval store (database, schema, or loaded embeddings) is not ready. */
export const RETRIEVAL_DOWN_CODES = ["retrieval_unavailable", "database_unavailable"] as const;

export function isRetrievalDown(err: unknown): boolean {
  return err instanceof ApiError && (err.kind === "unavailable" || RETRIEVAL_DOWN_CODES.some((c) => c === err.code));
}
