/**
 * Shared numeric formatting (§13). Precision follows the bible: 1 decimal for
 * spatial summaries in yards, 2 for ADE/FDE, 3 for cosine similarity, 1 for
 * percentages and milliseconds. Missing values render as an em dash; callers
 * supply the reason next to it.
 */
import type { PlaySummary } from "@/lib/contracts";

export const DASH = "—";
const MINUS = "−";

export function fixed(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const s = Math.abs(value).toFixed(decimals);
  const isZero = Number(s) === 0;
  return value < 0 && !isZero ? `${MINUS}${s}` : s;
}

export function signed(value: number | null | undefined, decimals: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return DASH;
  const s = Math.abs(value).toFixed(decimals);
  if (Number(s) === 0) return s;
  return `${value < 0 ? MINUS : "+"}${s}`;
}

export function withUnit(text: string, unit: string): string {
  return text === DASH ? DASH : `${text} ${unit}`;
}

export const yards = (v: number | null | undefined, d = 1) => withUnit(fixed(v, d), "yd");
export const speed = (v: number | null | undefined, d = 1) => withUnit(fixed(v, d), "yd/s");
export const accel = (v: number | null | undefined, d = 1) => withUnit(fixed(v, d), "yd/s²");
export const ms = (v: number | null | undefined, d = 1) => withUnit(fixed(v, d), "ms");
export const cosine = (v: number | null | undefined) => fixed(v, 3);

export function seconds(v: number, d = 1): string {
  return `${fixed(v, d)} s`;
}

/** Elapsed replay time relative to the time origin: "+1.4 s", "−0.8 s". */
export function elapsed(v: number): string {
  return `${signed(v, 1)} s`;
}

export function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
}

export function downDistance(p: Pick<PlaySummary, "down" | "yards_to_go">): string | null {
  if (p.down === null) return null;
  if (p.yards_to_go === null) return ordinal(p.down);
  return `${ordinal(p.down)} & ${Number.isInteger(p.yards_to_go) ? p.yards_to_go : p.yards_to_go.toFixed(1)}`;
}

export function quarterClock(p: Pick<PlaySummary, "quarter" | "game_clock">): string | null {
  if (p.quarter === null && p.game_clock === null) return null;
  const q = p.quarter === null ? "Q?" : p.quarter > 4 ? "OT" : `Q${p.quarter}`;
  return p.game_clock ? `${q} ${p.game_clock}` : q;
}

export function outcome(yds: number | null): string | null {
  if (yds === null) return null;
  return `${signed(yds, 0)} yd`;
}

/** Supplied dataset codes (pass_result). Unknown codes are shown as supplied. */
const PASS_RESULTS: Record<string, string> = { C: "Complete", I: "Incomplete", IN: "Intercepted" };

export function passResult(code: string | null): string | null {
  return code === null ? null : (PASS_RESULTS[code] ?? code);
}

/** Result line for a play: "Complete · +18 yd", "Incomplete", or null when nothing was supplied. */
export function playResult(o: { pass_result: string | null; yards_gained: number | null }): string | null {
  const r = passResult(o.pass_result);
  const y = o.pass_result === "C" || r === null ? outcome(o.yards_gained) : null;
  return [r, y].filter(Boolean).join(" · ") || null;
}

/** Dataset label codes for display: "COVER_3_ZONE" → "Cover 3 zone", "I_FORM" → "I form". Codes like "3x1" are kept. */
export function codeLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  if (!/^[A-Z0-9_]+$/.test(code)) return code;
  const words = code.toLowerCase().split("_");
  return [words[0].charAt(0).toUpperCase() + words[0].slice(1), ...words.slice(1)].join(" ");
}

export function matchup(p: Pick<PlaySummary, "away_team" | "home_team">): string {
  return `${p.away_team} at ${p.home_team}`;
}

export function playerLabel(ref: { jersey: string | null; name: string | null; position: string | null }): string {
  const parts = [ref.jersey ? `#${ref.jersey}` : null, ref.name].filter(Boolean);
  return parts.length ? parts.join(" ") : "Unidentified player";
}

/** Short on-field label: jersey when supplied, otherwise position (real tracking has no jersey numbers). */
export function tokenLabel(ref: { jersey: string | null; position: string | null }): string | null {
  return ref.jersey ?? ref.position ?? null;
}

export function sideLabel(side: "offense" | "defense"): string {
  return side === "offense" ? "Offense" : "Defense";
}

export function percent(v: number | null | undefined, d = 1): string {
  const f = fixed(v === null || v === undefined ? v : v * 100, d);
  return f === DASH ? DASH : `${f}%`;
}
