import { describe, expect, it } from "vitest";
import { ApiError } from "@/lib/contracts";
import { HttpSource } from "./http";
import { createClient } from "./index";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function source(handler: Handler) {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(String(input));
    return handler(String(input), init);
  }) as typeof fetch;
  return { http: new HttpSource("http://api.test/", fetcher), calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const envelope = (status: number, code: string, message: string) => json({ error: { code, message, status, request_id: "r1", details: null } }, status);

describe("HTTP data source", () => {
  it("calls the versioned endpoints with the query in the URL", async () => {
    const { http, calls } = source(() => json({}));
    await http.listPlays({ sort: "recent", page: 2, page_size: 50, week: 3, coverage: "COVER_3_ZONE", q: "" });
    await http.getFrames("2023091008-3826");
    await http.getFuture("2023091008-3826");
    expect(calls).toEqual([
      "http://api.test/api/v1/plays?sort=recent&page=2&page_size=50&week=3&coverage=COVER_3_ZONE",
      "http://api.test/api/v1/plays/2023091008-3826/frames",
      "http://api.test/api/v1/plays/2023091008-3826/future",
    ]);
  });

  it("surfaces the API error envelope as a typed user error", async () => {
    const { http } = source(() => envelope(404, "play_not_found", "Play 1-1 is not in dataset x."));
    const err = await http.getPlay("1-1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ kind: "user", status: 404, code: "play_not_found", message: "Play 1-1 is not in dataset x." });
  });

  it("reports a missing dataset as a server error with the fix", async () => {
    const { http } = source(() => envelope(503, "dataset_unavailable", "No processed dataset. Run `pnpm data:dev`."));
    await expect(http.listPlays({ sort: "recent", page: 1, page_size: 50 })).rejects.toMatchObject({ kind: "server", status: 503, message: expect.stringContaining("pnpm data:dev") });
  });

  it("never falls back to fixture data when the API is unreachable", async () => {
    const { http } = source(() => {
      throw new TypeError("fetch failed");
    });
    const client = createClient(http);
    const err = await client.listPlays({ sort: "recent", page: 1, page_size: 50 }).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: "network", message: expect.stringContaining("could not be reached at http://api.test/") });
  });

  it("rejects a payload that breaks the contract instead of rendering it", async () => {
    const { http } = source(() => json({ id: 7, frames: "nope" }));
    await expect(createClient(http).getFrames("1-1")).rejects.toMatchObject({ kind: "contract" });
  });

  it("posts trajectory requests and reads evaluation reports from the served model", async () => {
    const seen: Array<{ url: string; method?: string; body?: unknown }> = [];
    const { http } = source((url, init) => {
      seen.push({ url, method: init?.method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      return json({});
    });
    const req = { play_id: "2023091008-3826", origin_frame_id: 21, horizon_s: 2.4, player_ids: null };
    await http.predictTrajectory(req);
    await http.getEvaluation("trajectory-gnn-transformer-v1");
    expect(seen[0]).toEqual({ url: "http://api.test/api/v1/predict/trajectory", method: "POST", body: req });
    expect(seen[1].url).toBe("http://api.test/api/v1/evaluation/summary?model_version=trajectory-gnn-transformer-v1");
  });

  it("surfaces an unsupported forecast as a user error with its reason", async () => {
    const { http } = source(() => envelope(422, "unsupported_prediction", "The model forecasts only from the last observed frame (21)."));
    await expect(http.predictTrajectory({ play_id: "1-1", origin_frame_id: 3, horizon_s: 1, player_ids: null })).rejects.toMatchObject({
      kind: "user",
      code: "unsupported_prediction",
    });
  });

  it("marks unserved model capabilities unavailable without calling the network", async () => {
    const { http, calls } = source(() => json({}));
    for (const p of [http.findSimilar(), http.getPlayLabConfig(), http.runCounterfactual(), http.compare()]) {
      await expect(p).rejects.toMatchObject({ kind: "unavailable" });
    }
    expect(calls).toEqual([]);
  });

  it("propagates aborts untouched", async () => {
    const { http } = source(() => {
      throw new DOMException("Aborted", "AbortError");
    });
    await expect(http.getPlay("1-1")).rejects.toMatchObject({ name: "AbortError" });
  });
});
