/**
 * Web ⇄ API contract (Masterbrain §21, C01). Every payload that crosses the
 * boundary is parsed with these schemas, including the development fixture,
 * so the fixture cannot drift from what the FastAPI service must return.
 *
 * Coordinates are always SOURCE coordinates in yards: x ∈ [0, 120] along the
 * long axis including both end zones, y ∈ [0, 53⅓] across the field.
 * Angles follow the Next Gen Stats convention: degrees, 0° = +y, clockwise.
 * Direction normalization is a display transform only (lib/tracking/geometry).
 */
import { z } from "zod";

export const SCHEMA_VERSION = "1";

const nullableNumber = z.number().nullable();

export const PlaySideSchema = z.enum(["offense", "defense"]);
export type PlaySide = z.infer<typeof PlaySideSchema>;

export const PlayDirectionSchema = z.enum(["left", "right"]);
export type PlayDirection = z.infer<typeof PlayDirectionSchema>;

export const PlayTypeSchema = z.enum(["pass", "run", "other"]);
export type PlayType = z.infer<typeof PlayTypeSchema>;

export const ProvenanceSchema = z.object({
  source: z.string(),
  dataset_version: z.string(),
  schema_version: z.string(),
  coordinate_convention: z.string(),
  synthetic: z.boolean(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const PlaySummarySchema = z.object({
  play_id: z.string(),
  game_id: z.string(),
  season: z.number().int().nullable(),
  week: z.number().int().nullable(),
  game_date: z.string().nullable(),
  play_sequence: z.number().int(),
  home_team: z.string(),
  away_team: z.string(),
  offense: z.string().nullable(),
  defense: z.string().nullable(),
  quarter: z.number().int().nullable(),
  game_clock: z.string().nullable(),
  down: z.number().int().min(1).max(4).nullable(),
  yards_to_go: nullableNumber,
  yardline_label: z.string().nullable(),
  play_type: PlayTypeSchema.nullable(),
  description: z.string().nullable(),
  outcome_yards: nullableNumber,
});
export type PlaySummary = z.infer<typeof PlaySummarySchema>;

export const PlayerRefSchema = z.object({
  player_id: z.string(),
  jersey: z.string().nullable(),
  name: z.string().nullable(),
  side: PlaySideSchema,
  position: z.string().nullable(),
});
export type PlayerRef = z.infer<typeof PlayerRefSchema>;

export const PlayEventSchema = z.object({
  frame_id: z.number().int(),
  event: z.string(),
});
export type PlayEvent = z.infer<typeof PlayEventSchema>;

export const PlayDetailSchema = PlaySummarySchema.extend({
  players: z.array(PlayerRefSchema),
  events: z.array(PlayEventSchema),
  play_direction: PlayDirectionSchema.nullable(),
  line_of_scrimmage_x: nullableNumber,
  first_down_x: nullableNumber,
  frame_rate_hz: z.number().positive(),
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
  time_s: z.number(),
  ball: z.object({ x: z.number(), y: z.number() }).nullable(),
  players: z.array(FramePlayerSchema),
});

export const FramesPayloadSchema = z.object({
  play_id: z.string(),
  frames: z.array(FrameSchema),
});
export type FramesPayload = z.infer<typeof FramesPayloadSchema>;

export const PlaySortSchema = z.enum(["recent", "similarity"]);
export type PlaySort = z.infer<typeof PlaySortSchema>;

export const DistanceBandSchema = z.enum(["short", "medium", "long"]);
export type DistanceBand = z.infer<typeof DistanceBandSchema>;

export const OutcomeFilterSchema = z.enum(["gain", "no_gain", "loss", "unknown"]);
export type OutcomeFilter = z.infer<typeof OutcomeFilterSchema>;

export interface PlayQuery {
  q?: string;
  season?: number;
  offense?: string;
  defense?: string;
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
  dataset_version: z.string().nullable(),
  play_count: z.number().int(),
  source: z.string().nullable(),
  synthetic: z.boolean(),
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
  teams: z.array(z.string()),
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
});
export type ModelInfo = z.infer<typeof ModelInfoSchema>;

/* ---------- Trajectory prediction ---------- */

export const PathPointSchema = z.object({ x: z.number(), y: z.number() });
export type PathPoint = z.infer<typeof PathPointSchema>;

export const PredictedPlayerSchema = z.object({
  player_id: z.string(),
  /** Positions at origin + (k+1)·step_s, source coordinates. */
  path: z.array(PathPointSchema),
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
  origin_frame_id: z.number().int(),
  horizon_s: z.number().positive(),
  player_ids: z.array(z.string()).nullable(),
});
export type TrajectoryRequest = z.infer<typeof TrajectoryRequestSchema>;

export const TrajectoryPredictionSchema = z.object({
  request_id: z.string(),
  play_id: z.string(),
  model_version: z.string(),
  origin_frame_id: z.number().int(),
  input_window: z.object({ start_frame_id: z.number().int(), end_frame_id: z.number().int() }),
  horizon_s: z.number(),
  step_s: z.number().positive(),
  players: z.array(PredictedPlayerSchema),
  uncertainty: TrajectoryUncertaintySchema,
  latency_ms: z.number(),
  latency_scope: z.string(),
  warnings: z.array(z.string()),
});
export type TrajectoryPrediction = z.infer<typeof TrajectoryPredictionSchema>;

/* ---------- Similarity and compare ---------- */

export const SimilarRequestSchema = z.object({
  play_id: z.string(),
  k: z.number().int().positive(),
});
export type SimilarRequest = z.infer<typeof SimilarRequestSchema>;

export const SimilarResultSchema = z.object({
  request_id: z.string(),
  source_play_id: z.string(),
  model_version: z.string(),
  model_kind: ModelKindSchema,
  scope: z.object({
    description: z.string(),
    corpus_size: z.number().int(),
    index: z.enum(["exact", "hnsw"]),
    self_match_excluded: z.boolean(),
  }),
  results: z.array(
    z.object({
      rank: z.number().int(),
      score: z.number(),
      play: PlaySummarySchema,
    }),
  ),
  latency_ms: z.number(),
});
export type SimilarResult = z.infer<typeof SimilarResultSchema>;

export const CompareMeasureSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.string(),
  decimals: z.number().int().min(0).max(3),
  left: nullableNumber,
  right: nullableNumber,
  missing_reason: z.string().nullable(),
  definition: z.string(),
});
export type CompareMeasure = z.infer<typeof CompareMeasureSchema>;

export const CompareResultSchema = z.object({
  request_id: z.string(),
  left_play_id: z.string(),
  right_play_id: z.string(),
  similarity: z
    .object({ score: z.number(), model_version: z.string(), model_kind: ModelKindSchema })
    .nullable(),
  similarity_unavailable_reason: z.string().nullable(),
  window: z.string(),
  measures: z.array(CompareMeasureSchema),
  correspondence: z
    .object({
      method: z.string(),
      pairs: z.array(z.object({ left_player_id: z.string(), right_player_id: z.string() })),
    })
    .nullable(),
  source: z.string(),
});
export type CompareResult = z.infer<typeof CompareResultSchema>;

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

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly kind: "network" | "user" | "server" | "contract",
  ) {
    super(message);
    this.name = "ApiError";
  }
}
