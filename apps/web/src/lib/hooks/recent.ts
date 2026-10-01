/** Recently opened plays, per browser. A convenience only; failures are ignored. */
import type { PlaySummary } from "@/lib/contracts";

const KEY = "playlens:recent-plays:v2";

export interface RecentPlay {
  id: string;
  label: string;
  meta: string;
}

export function readRecentRaw(): string {
  try {
    return window.localStorage.getItem(KEY) ?? "[]";
  } catch {
    return "[]";
  }
}

function isRecent(v: unknown): v is RecentPlay {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r.id === "string" && typeof r.label === "string" && typeof r.meta === "string";
}

export function parseRecent(raw: string): RecentPlay[] {
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter(isRecent).slice(0, 3) : [];
  } catch {
    return [];
  }
}

export function pushRecent(p: PlaySummary, meta: string) {
  try {
    const entry: RecentPlay = { id: p.id, label: `${p.away_team} at ${p.home_team}`, meta };
    const next = [entry, ...parseRecent(readRecentRaw()).filter((r) => r.id !== p.id)].slice(0, 3);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}
