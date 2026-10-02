import type {
  CompareRequest,
  CounterfactualRequest,
  PlayQuery,
  SimilarityRequest,
  TrajectoryRequest,
} from "@/lib/contracts";

/**
 * A source returns raw JSON-shaped values. The client in ./index.ts parses
 * every value with the contract schemas, so the fixture and the FastAPI
 * service are held to the same contract.
 */
export interface RawSource {
  readonly kind: "fixture" | "api";
  getDataset(signal?: AbortSignal): Promise<unknown>;
  listPlays(query: PlayQuery, signal?: AbortSignal): Promise<unknown>;
  getFacets(signal?: AbortSignal): Promise<unknown>;
  getPlay(playId: string, signal?: AbortSignal): Promise<unknown>;
  getFrames(playId: string, signal?: AbortSignal): Promise<unknown>;
  /** Held-out actual future trajectories. Only requested when the play reports some. */
  getFuture(playId: string, signal?: AbortSignal): Promise<unknown>;
  listModels(signal?: AbortSignal): Promise<unknown>;
  findSimilar(req: SimilarityRequest, signal?: AbortSignal): Promise<unknown>;
  compare(req: CompareRequest, signal?: AbortSignal): Promise<unknown>;
  predictTrajectory(req: TrajectoryRequest, signal?: AbortSignal): Promise<unknown>;
  getPlayLabConfig(playId: string, signal?: AbortSignal): Promise<unknown>;
  runCounterfactual(req: CounterfactualRequest, signal?: AbortSignal): Promise<unknown>;
  getEvaluation(modelVersion: string, signal?: AbortSignal): Promise<unknown>;
}
