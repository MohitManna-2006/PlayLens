import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SimilaritySearchResponseSchema, type PlaySummary } from "@/lib/contracts";
import { agreements, chips, metric, requestFilters } from "./filters";

const example = SimilaritySearchResponseSchema.parse(
  JSON.parse(readFileSync(new URL("../../../../../packages/contracts/examples/similar-plays.json", import.meta.url), "utf8")),
);

const query = (over: Partial<PlaySummary> = {}): PlaySummary => ({ ...example.results[0].play, ...over });

describe("similar-play filter chips", () => {
  it("derive database filters from the query play's own context", () => {
    const q = query({ down: 3, yards_to_go: 7, quarter: 4, offense: "KC", context: { ...example.results[0].play.context, offense_formation: "SHOTGUN" } });
    const all = chips(q);
    expect(all.map((c) => c.label)).toEqual(["Same down · 3rd", "Distance 5–9 yd", "Same quarter · Q4", "Same formation · Shotgun", "Same offense · KC"]);
    expect(requestFilters(all, new Set())).toEqual({});
    expect(requestFilters(all, new Set(["same_down", "distance"]))).toEqual({ down: 3, yards_to_go_min: 5, yards_to_go_max: 9 });
    expect(requestFilters(all, new Set(["same_formation", "same_offense", "same_quarter"]))).toEqual({
      quarter: 4,
      offense_formation: "SHOTGUN",
      offense: "KC",
    });
  });

  it("never sends a filter for a field the play lacks, and clamps short distances", () => {
    const q = query({ down: null, yards_to_go: 1, quarter: 5, offense: null });
    const all = chips(q);
    expect(all.find((c) => c.key === "same_down")?.filters).toBeNull();
    expect(all.find((c) => c.key === "same_offense")?.filters).toBeNull();
    expect(all.find((c) => c.key === "same_quarter")?.label).toBe("Same quarter · OT");
    expect(requestFilters(all, new Set(["same_down", "distance", "same_offense"]))).toEqual({ yards_to_go_min: 1, yards_to_go_max: 3 });
  });
});

describe("result evidence summaries", () => {
  it("lists shared metadata as words, charted labels marked, most informative first", () => {
    const shared = agreements(example.results[0].evidence, 10);
    expect(shared[0].label).toBe("Same down");
    const coverage = shared.find((s) => s.label === "Same coverage label");
    expect(coverage?.charted).toBe(true);
    expect(shared.find((s) => s.label === "Same down")?.charted).toBe(false);
    expect(agreements(example.results[0].evidence).length).toBe(3);
  });

  it("finds structural metrics by key", () => {
    const sep = metric(example.results[0].evidence, "target_separation");
    expect(sep?.unit).toBe("yd");
    expect(sep?.frame_reference?.anchor).toBe("last_observed_frame");
    expect(metric(example.results[0].evidence, "nonexistent")).toBeNull();
  });
});
