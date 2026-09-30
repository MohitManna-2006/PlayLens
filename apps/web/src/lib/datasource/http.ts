/**
 * FastAPI implementation of the /api/v1 contract (Masterbrain §21.1).
 * Separates network, user (4xx), and server (5xx) failures so each screen
 * can show the right recovery action.
 */
import type { CounterfactualRequest, PlayQuery, SimilarRequest, TrajectoryRequest } from "@/lib/contracts";
import { ApiError } from "@/lib/contracts";
import type { RawSource } from "./types";

export class HttpSource implements RawSource {
  readonly kind = "api" as const;

  constructor(private readonly baseUrl: string) {}

  private async request(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/v1${path}`, {
        ...init,
        headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ApiError("The PlayLens API could not be reached.", null, "network");
    }
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { detail?: unknown };
        if (typeof body.detail === "string") detail = body.detail;
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(detail || `Request failed (${res.status})`, res.status, res.status < 500 ? "user" : "server");
    }
    return res.json();
  }

  private post(path: string, body: unknown, signal?: AbortSignal) {
    return this.request(path, { method: "POST", body: JSON.stringify(body), signal });
  }

  listPlays(q: PlayQuery, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
    return this.request(`/plays?${params}`, { signal });
  }
  getFacets(signal?: AbortSignal) {
    return this.request(`/plays/facets`, { signal });
  }
  getPlay(id: string, signal?: AbortSignal) {
    return this.request(`/plays/${encodeURIComponent(id)}`, { signal });
  }
  getFrames(id: string, signal?: AbortSignal) {
    return this.request(`/plays/${encodeURIComponent(id)}/frames`, { signal });
  }
  listModels(signal?: AbortSignal) {
    return this.request(`/models`, { signal });
  }
  findSimilar(req: SimilarRequest, signal?: AbortSignal) {
    return this.post(`/search/similar`, req, signal);
  }
  compare(left: string, right: string, signal?: AbortSignal) {
    return this.post(`/compare`, { left_play_id: left, right_play_id: right }, signal);
  }
  predictTrajectory(req: TrajectoryRequest, signal?: AbortSignal) {
    return this.post(`/predict/trajectory`, req, signal);
  }
  getPlayLabConfig(id: string, signal?: AbortSignal) {
    return this.request(`/playlab/${encodeURIComponent(id)}/config`, { signal });
  }
  runCounterfactual(req: CounterfactualRequest, signal?: AbortSignal) {
    return this.post(`/playlab/counterfactual`, req, signal);
  }
  getEvaluation(modelVersion: string, signal?: AbortSignal) {
    return this.request(`/evaluation/summary?model_version=${encodeURIComponent(modelVersion)}`, { signal });
  }
}
