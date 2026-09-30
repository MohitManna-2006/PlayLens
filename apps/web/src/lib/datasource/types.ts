import type {
  CounterfactualRequest,
  PlayQuery,
  SimilarRequest,
  TrajectoryRequest,
} from "@/lib/contracts";

/**
 * A source returns raw JSON-shaped values. The client in ./index.ts parses
 * every value with the contract schemas, so the fixture and the FastAPI
 * service are held to the same contract.
 */
export interface RawSource {
  readonly kind: "fixture" | "api";
  listPlays(query: PlayQuery, signal?: AbortSignal): Promise<unknown>;
  getFacets(signal?: AbortSignal): Promise<unknown>;
  getPlay(playId: string, signal?: AbortSignal): Promise<unknown>;
  getFrames(playId: string, signal?: AbortSignal): Promise<unknown>;
  listModels(signal?: AbortSignal): Promise<unknown>;
  findSimilar(req: SimilarRequest, signal?: AbortSignal): Promise<unknown>;
  compare(left: string, right: string, signal?: AbortSignal): Promise<unknown>;
  predictTrajectory(req: TrajectoryRequest, signal?: AbortSignal): Promise<unknown>;
  getPlayLabConfig(playId: string, signal?: AbortSignal): Promise<unknown>;
  runCounterfactual(req: CounterfactualRequest, signal?: AbortSignal): Promise<unknown>;
  getEvaluation(modelVersion: string, signal?: AbortSignal): Promise<unknown>;
}
