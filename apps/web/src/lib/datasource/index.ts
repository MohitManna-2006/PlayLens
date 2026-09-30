/**
 * Typed client over the selected source. Every response is parsed against the
 * contract schemas; a mismatch surfaces as a contract error rather than
 * rendering partially trusted data.
 */
import type { ZodType } from "zod";
import {
  ApiError,
  CompareResultSchema,
  CounterfactualResultSchema,
  EvaluationReportSchema,
  FacetsSchema,
  FramesPayloadSchema,
  ModelInfoSchema,
  PlayDetailSchema,
  PlayLabConfigSchema,
  PlayPageSchema,
  SimilarResultSchema,
  TrajectoryPredictionSchema,
  type CounterfactualRequest,
  type PlayQuery,
  type SimilarRequest,
  type TrajectoryRequest,
} from "@/lib/contracts";
import { FixtureSource } from "./fixture";
import { HttpSource } from "./http";
import type { RawSource } from "./types";

export type DataSourceKind = "fixture" | "api";

export const DATA_SOURCE_KIND: DataSourceKind =
  process.env.NEXT_PUBLIC_PLAYLENS_DATA_SOURCE === "api" ? "api" : "fixture";

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
    listPlays: (q: PlayQuery, s?: AbortSignal) => raw.listPlays(q, s).then(parse(PlayPageSchema, "play list")),
    getFacets: (s?: AbortSignal) => raw.getFacets(s).then(parse(FacetsSchema, "filter options")),
    getPlay: (id: string, s?: AbortSignal) => raw.getPlay(id, s).then(parse(PlayDetailSchema, "play")),
    getFrames: (id: string, s?: AbortSignal) => raw.getFrames(id, s).then(parse(FramesPayloadSchema, "tracking frames")),
    listModels: (s?: AbortSignal) => raw.listModels(s).then(parse(ModelListSchema, "model list")),
    findSimilar: (r: SimilarRequest, s?: AbortSignal) => raw.findSimilar(r, s).then(parse(SimilarResultSchema, "similar plays")),
    compare: (l: string, r: string, s?: AbortSignal) => raw.compare(l, r, s).then(parse(CompareResultSchema, "comparison")),
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
    const raw: RawSource =
      DATA_SOURCE_KIND === "api"
        ? new HttpSource(process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000")
        : new FixtureSource();
    client = createClient(raw);
  }
  return client;
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return "Something went wrong.";
}
