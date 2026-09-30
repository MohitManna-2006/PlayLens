/** Recently opened plays, per browser. A convenience only; failures are ignored. */
import type { PlaySummary } from "@/lib/contracts";

const KEY = "playlens:recent-plays";

export interface RecentPlay {
  play_id: string;
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

export function parseRecent(raw: string): RecentPlay[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as RecentPlay[]).slice(0, 3) : [];
  } catch {
    return [];
  }
}

export function pushRecent(p: PlaySummary, meta: string) {
  try {
    const entry: RecentPlay = { play_id: p.play_id, label: `${p.away_team} at ${p.home_team}`, meta };
    const next = [entry, ...parseRecent(readRecentRaw()).filter((r) => r.play_id !== p.play_id)].slice(0, 3);
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}
