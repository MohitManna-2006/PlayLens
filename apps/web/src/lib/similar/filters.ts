/**
 * Similar Plays filter chips. Each chip is defined relative to the query play's
 * own pre-snap context and becomes a database filter in the search request;
 * nothing is filtered in the browser.
 */
import type { Evidence, PlaySummary, SimilarityFilters } from "@/lib/contracts";
import { codeLabel, ordinal } from "@/lib/format";

export type ChipKey = "same_down" | "distance" | "same_quarter" | "same_formation" | "same_offense";

export const CHIP_ORDER: ChipKey[] = ["same_down", "distance", "same_quarter", "same_formation", "same_offense"];
export const DISTANCE_WINDOW = 2;

export interface Chip {
  key: ChipKey;
  label: string;
  /** Null when the query play lacks the field the chip needs. */
  filters: Partial<SimilarityFilters> | null;
}

export function chips(q: Pick<PlaySummary, "down" | "yards_to_go" | "quarter" | "offense" | "context">): Chip[] {
  const ytg = q.yards_to_go;
  const quarter = q.quarter === null ? null : q.quarter > 4 ? "OT" : `Q${q.quarter}`;
  return [
    { key: "same_down", label: q.down === null ? "Same down" : `Same down · ${ordinal(q.down)}`, filters: q.down === null ? null : { down: q.down } },
    {
      key: "distance",
      label: ytg === null ? "Similar distance" : `Distance ${Math.max(1, ytg - DISTANCE_WINDOW)}–${ytg + DISTANCE_WINDOW} yd`,
      filters: ytg === null ? null : { yards_to_go_min: Math.max(1, ytg - DISTANCE_WINDOW), yards_to_go_max: ytg + DISTANCE_WINDOW },
    },
    { key: "same_quarter", label: quarter ? `Same quarter · ${quarter}` : "Same quarter", filters: q.quarter === null ? null : { quarter: q.quarter } },
    {
      key: "same_formation",
      label: q.context.offense_formation ? `Same formation · ${codeLabel(q.context.offense_formation)}` : "Same formation",
      filters: q.context.offense_formation ? { offense_formation: q.context.offense_formation } : null,
    },
    { key: "same_offense", label: q.offense ? `Same offense · ${q.offense}` : "Same offense", filters: q.offense ? { offense: q.offense } : null },
  ];
}

/** The request filters for the active chips, in a stable key order. */
export function requestFilters(all: Chip[], active: ReadonlySet<ChipKey>): Partial<SimilarityFilters> {
  const out: Partial<SimilarityFilters> = {};
  for (const key of CHIP_ORDER) {
    const chip = all.find((c) => c.key === key);
    if (active.has(key) && chip?.filters) Object.assign(out, chip.filters);
  }
  return out;
}

const AGREEMENT_ORDER = ["down", "yards_to_go", "offense_formation", "receiver_alignment", "quarter", "coverage_type", "target_route"];
const SHORT: Record<string, string> = {
  down: "Same down",
  yards_to_go: "Same distance",
  offense_formation: "Same formation",
  receiver_alignment: "Same alignment",
  quarter: "Same quarter",
  coverage_type: "Same coverage label",
  target_route: "Same target route",
};

/** Metadata the two plays share, most informative first (labels, not colors). */
export function agreements(evidence: Evidence[], limit = 3): Array<{ id: string; label: string; charted: boolean; definition: string }> {
  const byKey = new Map(evidence.filter((e) => e.kind === "metadata" && e.relation === "same").map((e) => [e.id.split(".metadata.")[1], e]));
  return AGREEMENT_ORDER.filter((k) => byKey.has(k))
    .slice(0, limit)
    .map((k) => {
      const e = byKey.get(k)!;
      return { id: e.id, label: SHORT[k], charted: e.source === "charted_label", definition: e.definition };
    });
}

/** A structural metric by key, e.g. "target_separation". */
export function metric(evidence: Evidence[], key: string): Evidence | null {
  return evidence.find((e) => e.kind === "structural_metric" && e.id.includes(`.structure.${key}`)) ?? null;
}
