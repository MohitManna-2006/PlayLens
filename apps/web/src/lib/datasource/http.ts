/**
 * FastAPI implementation of the /api/v1 contract (Masterbrain §21.1).
 * Separates network, user (4xx), server (5xx), and unavailable failures so each
 * screen can show the right state. It never substitutes fixture data.
 */
import type { PlayQuery, TrajectoryRequest } from "@/lib/contracts";
import { ApiError, ErrorEnvelopeSchema } from "@/lib/contracts";
import type { RawSource } from "./types";

/**
 * Model capabilities the API does not serve yet (no trained model exists).
 * These reject without a network call; screens render an unavailable state.
 */
function notServed(what: string, why = "no model has been trained or served"): Promise<never> {
  return Promise.reject(new ApiError(`${what} is not available from the PlayLens API yet: ${why}.`, null, "unavailable", "not_served"));
}

export class HttpSource implements RawSource {
  readonly kind = "api" as const;

  constructor(
    private readonly baseUrl: string,
    private readonly fetcher: typeof fetch = (...args) => fetch(...args),
  ) {}

  private async request(path: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<unknown> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${path}`;
    let res: Response;
    try {
      res = await this.fetcher(url, { ...init, headers: { Accept: "application/json", ...init.headers } });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      throw new ApiError(
        `The PlayLens API could not be reached at ${this.baseUrl}. Start it with \`pnpm dev:api\`, or check NEXT_PUBLIC_PLAYLENS_API_BASE_URL.`,
        null,
        "network",
      );
    }
    if (!res.ok) {
      let message = res.statusText || `Request failed (${res.status})`;
      let code: string | null = null;
      try {
        const env = ErrorEnvelopeSchema.safeParse(await res.json());
        if (env.success) {
          message = env.data.error.message;
          code = env.data.error.code;
        }
      } catch {
        /* non-JSON error body */
      }
      throw new ApiError(message, res.status, res.status < 500 ? "user" : "server", code);
    }
    try {
      return await res.json();
    } catch {
      throw new ApiError(`The response from ${path} was not valid JSON.`, res.status, "contract");
    }
  }

  getDataset(signal?: AbortSignal) {
    return this.request(`/api/v1/dataset`, { signal });
  }
  listPlays(q: PlayQuery, signal?: AbortSignal) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== "") params.set(k, String(v));
    return this.request(`/api/v1/plays?${params}`, { signal });
  }
  getFacets(signal?: AbortSignal) {
    return this.request(`/api/v1/plays/facets`, { signal });
  }
  getPlay(id: string, signal?: AbortSignal) {
    return this.request(`/api/v1/plays/${encodeURIComponent(id)}`, { signal });
  }
  getFrames(id: string, signal?: AbortSignal) {
    return this.request(`/api/v1/plays/${encodeURIComponent(id)}/frames`, { signal });
  }
  getFuture(id: string, signal?: AbortSignal) {
    return this.request(`/api/v1/plays/${encodeURIComponent(id)}/future`, { signal });
  }
  listModels(signal?: AbortSignal) {
    return this.request(`/api/v1/models`, { signal });
  }
  findSimilar() {
    return notServed("Similar-play retrieval");
  }
  compare() {
    return notServed("Structural comparison", "the compare endpoint is not implemented");
  }
  predictTrajectory(req: TrajectoryRequest, signal?: AbortSignal) {
    return this.request(`/api/v1/predict/trajectory`, {
      method: "POST",
      body: JSON.stringify(req),
      headers: { "Content-Type": "application/json" },
      signal,
    });
  }
  getPlayLabConfig() {
    return notServed("PlayLab");
  }
  runCounterfactual() {
    return notServed("PlayLab");
  }
  getEvaluation(modelVersion: string, signal?: AbortSignal) {
    return this.request(`/api/v1/evaluation/summary?model_version=${encodeURIComponent(modelVersion)}`, { signal });
  }
}
