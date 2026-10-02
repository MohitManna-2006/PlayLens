/**
 * Typed client over the selected source. Every response is parsed against the
 * contract schemas; a mismatch surfaces as a contract error rather than
 * rendering partially trusted data.
 *
 * The PlayLens API is the default. The synthetic fixture runs only when
 * NEXT_PUBLIC_PLAYLENS_DATA_SOURCE=fixture is set explicitly; there is no
 * automatic fallback, so an unreachable API shows an error, never fixture plays.
 */
import type { ZodType } from "zod";
import {
  ApiError,
  CompareResponseSchema,
  CounterfactualResultSchema,
  DatasetStatusSchema,
  EvaluationReportSchema,
  FacetsSchema,
  FramesPayloadSchema,
  FuturePayloadSchema,
  ModelInfoSchema,
  PlayDetailSchema,
  PlayLabConfigSchema,
  PlayPageSchema,
  SimilaritySearchResponseSchema,
  TrajectoryPredictionSchema,
  type CompareRequest,
  type CounterfactualRequest,
  type PlayQuery,
  type SimilarityRequest,
  type TrajectoryRequest,
} from "@/lib/contracts";
import { FixtureSource } from "./fixture";
import { HttpSource } from "./http";
import type { RawSource } from "./types";

export type DataSourceKind = "fixture" | "api";

export const DATA_SOURCE_KIND: DataSourceKind = process.env.NEXT_PUBLIC_PLAYLENS_DATA_SOURCE === "fixture" ? "fixture" : "api";

export const API_BASE_URL = process.env.NEXT_PUBLIC_PLAYLENS_API_BASE_URL || "http://localhost:8000";

function parse<T>(schema: ZodType<T>, what: string) {
  return (raw: unknown): T => {
    const r = schema.safeParse(raw);
    if (!r.success) {
      console.error(`[PlayLens] ${what} failed contract validation`, r.error.issues.slice(0, 5));
      throw new ApiError(`The ${what} response did not match the expected contract.`, null, "contract");
    }
    return r.data;
  };
}

const ModelListSchema = ModelInfoSchema.array();

export function createClient(raw: RawSource) {
  return {
    kind: raw.kind,
    getDataset: (s?: AbortSignal) => raw.getDataset(s).then(parse(DatasetStatusSchema, "dataset status")),
    listPlays: (q: PlayQuery, s?: AbortSignal) => raw.listPlays(q, s).then(parse(PlayPageSchema, "play list")),
    getFacets: (s?: AbortSignal) => raw.getFacets(s).then(parse(FacetsSchema, "filter options")),
    getPlay: (id: string, s?: AbortSignal) => raw.getPlay(id, s).then(parse(PlayDetailSchema, "play")),
    getFrames: (id: string, s?: AbortSignal) => raw.getFrames(id, s).then(parse(FramesPayloadSchema, "tracking frames")),
    getFuture: (id: string, s?: AbortSignal) => raw.getFuture(id, s).then(parse(FuturePayloadSchema, "actual future trajectories")),
    listModels: (s?: AbortSignal) => raw.listModels(s).then(parse(ModelListSchema, "model list")),
    findSimilar: (r: SimilarityRequest, s?: AbortSignal) => raw.findSimilar(r, s).then(parse(SimilaritySearchResponseSchema, "similar plays")),
    compare: (r: CompareRequest, s?: AbortSignal) => raw.compare(r, s).then(parse(CompareResponseSchema, "comparison")),
    predictTrajectory: (r: TrajectoryRequest, s?: AbortSignal) =>
      raw.predictTrajectory(r, s).then(parse(TrajectoryPredictionSchema, "trajectory prediction")),
    getPlayLabConfig: (id: string, s?: AbortSignal) => raw.getPlayLabConfig(id, s).then(parse(PlayLabConfigSchema, "PlayLab configuration")),
    runCounterfactual: (r: CounterfactualRequest, s?: AbortSignal) =>
      raw.runCounterfactual(r, s).then(parse(CounterfactualResultSchema, "counterfactual")),
    getEvaluation: (v: string, s?: AbortSignal) => raw.getEvaluation(v, s).then(parse(EvaluationReportSchema, "evaluation report")),
  };
}

export type PlayLensClient = ReturnType<typeof createClient>;

let client: PlayLensClient | null = null;

export function getClient(): PlayLensClient {
  if (!client) {
    const raw: RawSource = DATA_SOURCE_KIND === "api" ? new HttpSource(API_BASE_URL) : new FixtureSource();
    client = createClient(raw);
  }
  return client;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
