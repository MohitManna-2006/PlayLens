import {
  DistanceBandSchema,
  OutcomeFilterSchema,
  PlayTypeSchema,
  type PlayQuery,
} from "@/lib/contracts";

export const PAGE_SIZE = 50;

const int = (v: string | null) => {
  if (v === null || v === "") return undefined;
  const n = Number(v);
  return Number.isInteger(n) ? n : undefined;
};

/** Filters, sort, and page live in the URL (§6) so returning from Play restores them. */
export function parseQuery(sp: URLSearchParams): PlayQuery {
  const similarTo = sp.get("similar_to") || undefined;
  const sort = sp.get("sort") === "recent" || !similarTo ? "recent" : "similarity";
  return {
    q: sp.get("q") || undefined,
    season: int(sp.get("season")),
    offense: sp.get("offense") || undefined,
    defense: sp.get("defense") || undefined,
    down: int(sp.get("down")),
    distance: DistanceBandSchema.safeParse(sp.get("distance")).data,
    play_type: PlayTypeSchema.safeParse(sp.get("play_type")).data,
    quarter: int(sp.get("quarter")),
    outcome: OutcomeFilterSchema.safeParse(sp.get("outcome")).data,
    sort,
    similar_to: similarTo,
    page: Math.max(1, int(sp.get("page")) ?? 1),
    page_size: PAGE_SIZE,
  };
}

export function toSearch(q: PlayQuery, extra: Record<string, string | null | undefined> = {}): string {
  const p = new URLSearchParams();
  const set = (k: string, v: unknown) => {
    if (v !== undefined && v !== null && v !== "") p.set(k, String(v));
  };
  set("q", q.q);
  set("season", q.season);
  set("offense", q.offense);
  set("defense", q.defense);
  set("down", q.down);
  set("distance", q.distance);
  set("play_type", q.play_type);
  set("quarter", q.quarter);
  set("outcome", q.outcome);
  set("similar_to", q.similar_to);
  if (q.similar_to && q.sort === "recent") set("sort", "recent");
  if (q.page > 1) set("page", q.page);
  for (const [k, v] of Object.entries(extra)) set(k, v);
  return p.toString();
}

export function activeFilterCount(q: PlayQuery): number {
  return [q.season, q.offense, q.defense, q.down, q.distance, q.play_type, q.quarter, q.outcome].filter((v) => v !== undefined).length;
}

export const DISTANCE_LABELS: Record<string, string> = { short: "Short (1–3)", medium: "Medium (4–7)", long: "Long (8+)" };
export const OUTCOME_LABELS: Record<string, string> = { gain: "Gain", no_gain: "No gain", loss: "Loss", unknown: "Unknown" };
