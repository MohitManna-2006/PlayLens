/**
 * Procedural play simulator for the development fixture.
 *
 * Produces synthetic tracking in the same shape as the real API so replay,
 * compare, and PlayLab can be built and reviewed before ingestion exists.
 * Nothing here is NFL data: teams, rosters, and plays are generated from a
 * fixed seed, players carry no names, and every surface that shows this data
 * is labeled "Synthetic fixture".
 *
 * Simulation runs in canonical coordinates (offense attacks +x), the same frame
 * the API serves. Each play still gets a recorded direction so the Source view
 * has something to undo.
 */
import type { PlayDirection, PlayerRef, PlaySummary, PlayType } from "@/lib/contracts";
import { formatPlayId } from "@/lib/playId";
import { FIELD_LENGTH, FIELD_WIDTH } from "@/lib/tracking/geometry";
import { hashString, Rng } from "./random";

export const FRAME_RATE = 10;
const DT = 1 / FRAME_RATE;
const SUBSTEPS = 5;
const H = DT / SUBSTEPS;
const W = FIELD_WIDTH;

export type Role = "QB" | "RB" | "WR" | "TE" | "OL" | "DL" | "LB" | "CB" | "S";

interface SlotDef {
  key: string;
  role: Role;
  position: string;
  range: [number, number];
}

const OFFENSE_SLOTS: SlotDef[] = [
  { key: "QB", role: "QB", position: "QB", range: [1, 19] },
  { key: "RB", role: "RB", position: "RB", range: [20, 39] },
  { key: "X", role: "WR", position: "WR", range: [10, 19] },
  { key: "Z", role: "WR", position: "WR", range: [80, 89] },
  { key: "SL", role: "WR", position: "WR", range: [10, 19] },
  { key: "TE", role: "TE", position: "TE", range: [80, 89] },
  { key: "LT", role: "OL", position: "T", range: [60, 79] },
  { key: "LG", role: "OL", position: "G", range: [60, 79] },
  { key: "C", role: "OL", position: "C", range: [50, 69] },
  { key: "RG", role: "OL", position: "G", range: [60, 79] },
  { key: "RT", role: "OL", position: "T", range: [60, 79] },
];

const DEFENSE_SLOTS: SlotDef[] = [
  { key: "LDE", role: "DL", position: "DE", range: [90, 99] },
  { key: "LDT", role: "DL", position: "DT", range: [90, 99] },
  { key: "RDT", role: "DL", position: "DT", range: [90, 99] },
  { key: "RDE", role: "DL", position: "DE", range: [50, 59] },
  { key: "WLB", role: "LB", position: "OLB", range: [40, 59] },
  { key: "MLB", role: "LB", position: "ILB", range: [40, 59] },
  { key: "CB1", role: "CB", position: "CB", range: [20, 39] },
  { key: "CB2", role: "CB", position: "CB", range: [20, 39] },
  { key: "NB", role: "CB", position: "CB", range: [20, 39] },
  { key: "FS", role: "S", position: "FS", range: [20, 49] },
  { key: "SS", role: "S", position: "SS", range: [20, 49] },
];

export const TEAMS = ["Team A", "Team B", "Team C", "Team D", "Team E", "Team F"] as const;
const TEAM_CODES = ["A", "B", "C", "D", "E", "F"];

interface RosterEntry {
  slot: SlotDef;
  ref: PlayerRef;
}

interface Roster {
  offense: RosterEntry[];
  defense: RosterEntry[];
}

const rosterCache = new Map<number, Roster>();

function roster(teamIndex: number): Roster {
  const cached = rosterCache.get(teamIndex);
  if (cached) return cached;
  const rng = new Rng(hashString(`roster:${TEAMS[teamIndex]}`));
  const used = new Set<number>();
  const assign = (slot: SlotDef, side: "offense" | "defense"): RosterEntry => {
    let n = rng.int(slot.range[0], slot.range[1]);
    let guard = 0;
    while (used.has(n) && guard++ < 200) n = rng.int(slot.range[0], slot.range[1]);
    while (used.has(n)) n = (n % 99) + 1;
    used.add(n);
    return {
      slot,
      ref: {
        player_id: `${TEAM_CODES[teamIndex]}-${n}`,
        nfl_id: null,
        jersey: String(n),
        name: null,
        side,
        position: slot.position,
        role: null,
        player_to_predict: false,
      },
    };
  };
  const r = {
    offense: OFFENSE_SLOTS.map((s) => assign(s, "offense")),
    defense: DEFENSE_SLOTS.map((s) => assign(s, "defense")),
  };
  rosterCache.set(teamIndex, r);
  return r;
}

/* ------------------------------------------------------------------ */

interface Vec {
  x: number;
  y: number;
}

interface Route {
  /** Precomputed positions at every substep from the snap. */
  track: Vec[];
  /** Substep index at which the route runner stops (stop routes only). */
  endStep: number | null;
}

const clampY = (y: number) => Math.min(W - 1, Math.max(1, y));
const clampX = (x: number) => Math.min(FIELD_LENGTH - 1, Math.max(1, x));

type RouteKind =
  | "go"
  | "slant"
  | "out"
  | "dig"
  | "curl"
  | "post"
  | "corner"
  | "hitch"
  | "flat"
  | "seam"
  | "check"
  | "release";

const ROUTE_SHAPES: Record<RouteKind, { pts: Array<[number, number]>; stop: boolean }> = {
  go: { pts: [[0, 0], [45, 0]], stop: false },
  slant: { pts: [[0, 0], [2.5, 0], [22, 14]], stop: false },
  out: { pts: [[0, 0], [9, 0], [9.5, -14]], stop: true },
  dig: { pts: [[0, 0], [12, 0], [12.5, 22]], stop: false },
  curl: { pts: [[0, 0], [11, 0], [9.5, 1.5]], stop: true },
  post: { pts: [[0, 0], [11, 0], [34, 14]], stop: false },
  corner: { pts: [[0, 0], [11, 0], [26, -12]], stop: false },
  hitch: { pts: [[0, 0], [6, 0], [5, 0]], stop: true },
  flat: { pts: [[0, 0], [1, -3], [5, -14]], stop: false },
  seam: { pts: [[0, 0], [45, 1]], stop: false },
  check: { pts: [[0, 0], [1, 2], [4, 4]], stop: true },
  release: { pts: [[0, 0], [5, 0]], stop: true },
};

function buildRoute(
  start: Vec,
  shape: { pts: Array<[number, number]>; stop: boolean },
  inside: number,
  vmax: number,
  accel: number,
  delay: number,
  maxSteps: number,
): Route {
  const pts = shape.pts.map(([dx, dy]) => ({ x: clampX(start.x + dx), y: clampY(start.y + dy * inside) }));
  const segLen: number[] = [];
  for (let i = 1; i < pts.length; i++) segLen.push(Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = segLen.reduce((a, b) => a + b, 0);
  const vertexAt: number[] = [];
  segLen.reduce((acc, l) => {
    vertexAt.push(acc + l);
    return acc + l;
  }, 0);

  const pointAt = (d: number): Vec => {
    let rem = Math.min(d, total);
    for (let i = 0; i < segLen.length; i++) {
      if (rem <= segLen[i] || i === segLen.length - 1) {
        const f = segLen[i] === 0 ? 0 : Math.min(1, rem / segLen[i]);
        return { x: pts[i].x + (pts[i + 1].x - pts[i].x) * f, y: pts[i].y + (pts[i + 1].y - pts[i].y) * f };
      }
      rem -= segLen[i];
    }
    return pts[pts.length - 1];
  };

  const track: Vec[] = [];
  let d = 0;
  let v = 0;
  let nextVertex = 0;
  let endStep: number | null = null;
  for (let k = 0; k <= maxSteps; k++) {
    const t = k * H;
    if (t > delay && d < total) {
      const remaining = total - d;
      const braking = shape.stop && remaining < (v * v) / (2 * accel * 1.6);
      v = braking ? Math.max(1.2, v - accel * 1.6 * H) : Math.min(vmax, v + accel * H);
      d += v * H;
      while (nextVertex < vertexAt.length - 1 && d >= vertexAt[nextVertex]) {
        v *= 0.58;
        nextVertex++;
      }
      if (d >= total) {
        d = total;
        if (shape.stop && endStep === null) endStep = k;
      }
    }
    track.push(pointAt(d));
  }
  return { track, endStep };
}

function routeAt(route: Route, tau: number): Vec {
  const k = Math.max(0, Math.min(route.track.length - 1, Math.round(tau / H)));
  return route.track[k];
}

/* ------------------------------------------------------------------ */

interface Body {
  entry: RosterEntry;
  side: "offense" | "defense";
  pos: Vec;
  vel: Vec;
  xs: number[];
  ys: number[];
}

function steer(b: Body, target: Vec, vmax: number, lag: number, amax = 7) {
  const dx = target.x - b.pos.x;
  const dy = target.y - b.pos.y;
  const d = Math.hypot(dx, dy);
  const want = d < 1e-6 ? 0 : Math.min(vmax, d / lag);
  const wx = d < 1e-6 ? 0 : (dx / d) * want;
  const wy = d < 1e-6 ? 0 : (dy / d) * want;
  let ax = (wx - b.vel.x) / H;
  let ay = (wy - b.vel.y) / H;
  const am = Math.hypot(ax, ay);
  if (am > amax) {
    ax = (ax / am) * amax;
    ay = (ay / am) * amax;
  }
  b.vel.x += ax * H;
  b.vel.y += ay * H;
  b.pos.x = clampX(b.pos.x + b.vel.x * H);
  b.pos.y = clampY(b.pos.y + b.vel.y * H);
}

function place(b: Body, p: Vec) {
  b.vel.x = (p.x - b.pos.x) / H;
  b.vel.y = (p.y - b.pos.y) / H;
  b.pos.x = p.x;
  b.pos.y = p.y;
}

function brake(b: Body) {
  const f = Math.exp(-H / 0.18);
  b.vel.x *= f;
  b.vel.y *= f;
  b.pos.x = clampX(b.pos.x + b.vel.x * H);
  b.pos.y = clampY(b.pos.y + b.vel.y * H);
}

/* ------------------------------------------------------------------ */

export type SpecialCase = "gap" | "no_ball" | "no_snap_event" | "dropout" | "no_description";

export interface SimPlay {
  index: number;
  summary: PlaySummary;
  direction: PlayDirection;
  /** Normalized LOS x. */
  los: number;
  cy: number;
  firstDown: number | null;
  frameCount: number;
  snapIndex: number;
  events: Array<{ index: number; event: string }>;
  refs: PlayerRef[];
  roles: Role[];
  /** Normalized, noise-free positions per player per frame. */
  xs: number[][];
  ys: number[][];
  ballX: number[];
  ballY: number[];
  special: SpecialCase | null;
  /** Frame indices omitted from the payload (tracking gap). */
  missing: Set<number>;
  /** Player index → first frame index at which that player is no longer tracked. */
  dropout: Map<number, number>;
  noiseSeed: number;
}

interface GameDef {
  season: number;
  week: number;
  date: string;
  home: number;
  away: number;
}

const GAMES: GameDef[] = [
  { season: 2025, week: 1, date: "2025-09-07", home: 0, away: 1 },
  { season: 2025, week: 2, date: "2025-09-14", home: 2, away: 3 },
  { season: 2025, week: 3, date: "2025-09-21", home: 4, away: 5 },
  { season: 2025, week: 4, date: "2025-09-28", home: 1, away: 2 },
  { season: 2025, week: 5, date: "2025-10-05", home: 3, away: 4 },
  { season: 2025, week: 6, date: "2025-10-12", home: 5, away: 0 },
  { season: 2025, week: 7, date: "2025-10-19", home: 2, away: 0 },
  { season: 2026, week: 1, date: "2026-09-13", home: 3, away: 1 },
  { season: 2026, week: 2, date: "2026-09-20", home: 4, away: 2 },
  { season: 2026, week: 3, date: "2026-09-27", home: 5, away: 3 },
];

export const PLAYS_PER_GAME = 12;
const SPECIAL_GAME = GAMES.length - 2;
const SPECIALS: Record<number, SpecialCase> = { 3: "gap", 5: "no_ball", 7: "no_snap_event", 9: "dropout", 11: "no_description" };

function pad(n: number, w: number) {
  return String(n).padStart(w, "0");
}

/** Synthetic games are numbered 1..GAME_COUNT and plays 1..PLAYS_PER_GAME; no NFL ID looks like this. */
export function fixturePlayId(gameIndex: number, seq: number) {
  return formatPlayId(gameIndex + 1, seq);
}

/** Seeds keep the Phase 1 key so every synthetic play is unchanged. */
function seedKey(gameIndex: number, seq: number) {
  return `fx${pad(gameIndex + 1, 2)}-${pad(seq, 3)}`;
}

function sideWord(dy: number): string {
  if (Math.abs(dy) < 5) return "middle";
  return dy > 0 ? "left" : "right";
}

export function simulate(gameIndex: number, seq: number): SimPlay {
  const game = GAMES[gameIndex];
  const index = gameIndex * PLAYS_PER_GAME + (seq - 1);
  const playId = fixturePlayId(gameIndex, seq);
  const rng = new Rng(hashString(`play:${seedKey(gameIndex, seq)}`));
  const special = gameIndex === SPECIAL_GAME ? (SPECIALS[seq] ?? null) : null;

  const offenseIsHome = rng.chance(0.5);
  const offTeam = offenseIsHome ? game.home : game.away;
  const defTeam = offenseIsHome ? game.away : game.home;
  const off = roster(offTeam).offense;
  const def = roster(defTeam).defense;

  const direction: PlayDirection = rng.chance(0.5) ? "right" : "left";
  const playType: PlayType = rng.chance(0.6) ? "pass" : "run";
  const shotgun = playType === "pass" ? rng.chance(0.75) : rng.chance(0.4);
  const fromGoal = Math.round(rng.range(12, 85));
  const los = 10 + fromGoal;
  const cy = rng.range(W / 2 - 3.1, W / 2 + 3.1);

  const quarter = Math.ceil(seq / 3);
  const inQuarter = (seq - 1) % 3;
  const clockMin = Math.max(0, 14 - inQuarter * 5 - rng.int(0, 3));
  const clock = `${pad(clockMin, 2)}:${pad(rng.int(0, 59), 2)}`;
  const down = rng.pick([1, 1, 1, 1, 2, 2, 2, 3, 3, 4]);
  let ytg = down === 1 ? (rng.chance(0.85) ? 10 : rng.int(5, 15)) : down === 4 ? rng.int(1, 3) : rng.int(1, 12);
  ytg = Math.min(ytg, 110 - los);

  /* ---- formation ---- */
  const slotSide = rng.chance(0.5) ? 1 : -1;
  const teSide = -slotSide;
  const rbSide = rng.chance(0.5) ? 1 : -1;
  const start: Record<string, Vec> = {
    QB: shotgun ? { x: los - 5.0, y: cy } : { x: los - 1.6, y: cy },
    RB: shotgun ? { x: los - 5.3, y: cy + rbSide * 1.5 } : { x: los - 7.0, y: cy },
    X: { x: los - 1.0, y: clampY(W - rng.range(5, 9)) },
    Z: { x: los - 1.2, y: clampY(rng.range(5, 9)) },
    SL: { x: los - 1.6, y: clampY(cy + slotSide * rng.range(8, 11)) },
    TE: { x: los - 1.3, y: cy + teSide * 4.0 },
    LT: { x: los - 1.3, y: cy + 2.6 },
    LG: { x: los - 1.1, y: cy + 1.3 },
    C: { x: los - 0.9, y: cy },
    RG: { x: los - 1.1, y: cy - 1.3 },
    RT: { x: los - 1.3, y: cy - 2.6 },
  };
  const xStart = start.X;
  const zStart = start.Z;
  const slStart = start.SL;
  const inside = (y: number) => (cy - y >= 0 ? 1 : -1);
  Object.assign(start, {
    LDE: { x: los + 1.2, y: cy + 3.9 },
    LDT: { x: los + 1.0, y: cy + 1.2 },
    RDT: { x: los + 1.0, y: cy - 1.2 },
    RDE: { x: los + 1.2, y: cy - 3.9 },
    WLB: { x: los + 4.5, y: cy + 3.0 },
    MLB: { x: los + 4.6, y: cy - 2.0 },
    CB1: { x: los + rng.range(4.5, 7), y: clampY(xStart.y + inside(xStart.y) * 0.8) },
    CB2: { x: los + rng.range(4.5, 7), y: clampY(zStart.y + inside(zStart.y) * 0.8) },
    NB: { x: los + rng.range(3.5, 5.5), y: slStart.y },
    FS: { x: los + rng.range(12, 15), y: clampY(cy + 7) },
    SS: { x: los + rng.range(9, 12), y: clampY(cy - 7) },
  } satisfies Record<string, Vec>);

  const bodies: Body[] = [...off, ...def].map((entry) => {
    const p = start[entry.slot.key];
    return { entry, side: entry.ref.side, pos: { ...p }, vel: { x: 0, y: 0 }, xs: [], ys: [] };
  });
  const byKey = new Map(bodies.map((b) => [b.entry.slot.key, b]));
  const get = (k: string) => byKey.get(k)!;

  /* ---- plan ---- */
  const preSnapFrames = rng.int(10, 14);
  const maxSteps = Math.round(9 / H);
  const routes = new Map<string, Route>();
  let throwTau = 0;
  let arriveTau = 0;
  let endTau = 0;
  let targetKey = "";
  let caught = false;
  let handoffTau = 0;
  let tackleTau: number | null = null;
  let arrivePoint: Vec = { x: 0, y: 0 };
  let yacDrift = 0;

  if (playType === "pass") {
    const wrKinds: RouteKind[] = ["go", "slant", "out", "dig", "curl", "post", "corner", "hitch"];
    const slotKinds: RouteKind[] = ["slant", "dig", "curl", "post", "out", "hitch"];
    const teKinds: RouteKind[] = ["seam", "flat", "curl", "dig"];
    const plan: Array<[string, RouteKind, number, number]> = [
      ["X", rng.pick(wrKinds), rng.range(8.1, 8.9), rng.range(0.05, 0.15)],
      ["Z", rng.pick(wrKinds), rng.range(8.1, 8.9), rng.range(0.05, 0.15)],
      ["SL", rng.pick(slotKinds), rng.range(7.8, 8.6), rng.range(0.05, 0.2)],
      ["TE", rng.pick(teKinds), rng.range(6.3, 7.0), rng.range(0.25, 0.4)],
      ["RB", rng.pick<RouteKind>(["flat", "check"]), rng.range(6.8, 7.5), rng.range(0.45, 0.7)],
    ];
    for (const [key, kind, vmax, delay] of plan) {
      const s = start[key];
      routes.set(key, buildRoute(s, ROUTE_SHAPES[kind], inside(s.y), vmax, 5.5, delay, maxSteps));
    }
    throwTau = rng.range(2.2, 3.0);
    targetKey = rng.pick(["X", "X", "Z", "Z", "SL", "SL", "SL", "TE", "TE", "RB"]);
    const qbAtThrow = qbPass(start.QB, shotgun, throwTau);
    let flight = 0.8;
    for (let it = 0; it < 3; it++) {
      const p = routeAt(routes.get(targetKey)!, throwTau + flight);
      flight = Math.max(0.45, Math.hypot(p.x - qbAtThrow.x, p.y - qbAtThrow.y) / 19);
    }
    arriveTau = throwTau + flight;
    arrivePoint = routeAt(routes.get(targetKey)!, arriveTau);
    caught = rng.chance(0.68);
    yacDrift = rng.range(-3, 3);
    if (caught) {
      tackleTau = arriveTau + rng.range(0.8, 2.4);
      endTau = tackleTau + 0.8;
    } else {
      endTau = arriveTau + 1.0;
    }
  } else {
    handoffTau = shotgun ? 0.6 : 0.75;
    const gapSide = rng.chance(0.5) ? 1 : -1;
    const gapY = cy + gapSide * rng.range(0.5, 4.5);
    const gain = Math.round(rng.range(-2, 11));
    const endX = clampX(los + gain);
    const rbShape = {
      pts: [
        [0, 0],
        [los - 4.0 - start.RB.x, cy + gapSide * 0.8 - start.RB.y],
        [los + 0.3 - start.RB.x, gapY - start.RB.y],
        [endX - start.RB.x, gapY + rng.range(-3, 3) - start.RB.y],
      ] as Array<[number, number]>,
      stop: true,
    };
    const rbRoute = buildRoute(start.RB, rbShape, 1, rng.range(6.4, 7.2), 4.2, 0.05, maxSteps);
    routes.set("RB", rbRoute);
    for (const key of ["X", "Z", "SL"]) {
      routes.set(key, buildRoute(start[key], ROUTE_SHAPES.release, 1, 6, 4, 0.1, maxSteps));
    }
    tackleTau = (rbRoute.endStep ?? Math.round(4 / H)) * H + 0.1;
    endTau = tackleTau + 0.8;
    targetKey = "RB";
  }

  const totalFrames = preSnapFrames + Math.ceil(endTau / DT) + 1;
  const ballX: number[] = [];
  const ballY: number[] = [];
  const snapIdx = preSnapFrames;
  let ball: Vec = { x: los - 0.3, y: cy };

  const carrierKey = (tau: number): string | null => {
    if (playType === "pass") {
      if (tau < throwTau) return "QB";
      if (caught && tau >= arriveTau) return targetKey;
      return null;
    }
    return tau < handoffTau ? "QB" : "RB";
  };

  for (let f = 0; f < totalFrames; f++) {
    for (let s = 0; s < (f === 0 ? 1 : SUBSTEPS); s++) {
      if (f === 0) break;
      const tau = (f - snapIdx - 1) * DT + (s + 1) * H;
      if (tau <= 0) continue;
      const tackled = tackleTau !== null && tau > tackleTau;
      const carrier = carrierKey(tau);
      const carrierBody = carrier ? get(carrier) : null;
      const lead = (b: Body, secs: number): Vec => ({ x: b.pos.x + b.vel.x * secs, y: b.pos.y + b.vel.y * secs });

      for (const b of bodies) {
        const key = b.entry.slot.key;
        const role = b.entry.slot.role;
        if (tackled) {
          brake(b);
          continue;
        }
        if (b.side === "offense") {
          if (playType === "pass") {
            if (role === "OL") {
              const s0 = start[key];
              const k = Math.min(1, tau / 1.0);
              place(b, { x: s0.x - 1.6 * k, y: s0.y + (s0.y - cy) * 0.15 * k });
            } else if (key === "QB") {
              if (tau < throwTau) place(b, qbPass(start.QB, shotgun, tau));
              else brake(b);
            } else if (caught && key === targetKey && tau >= arriveTau) {
              steer(b, { x: b.pos.x + 10, y: b.pos.y + yacDrift }, 7.2, 0.3, 6);
            } else {
              const r = routes.get(key);
              if (r) {
                const p = routeAt(r, tau);
                if (tau > arriveTau + 0.3) steer(b, p, 3, 0.5);
                else place(b, p);
              }
            }
          } else {
            if (role === "OL") {
              const s0 = start[key];
              const k = Math.min(1, tau / 0.8);
              place(b, { x: s0.x + 1.6 * k, y: s0.y });
            } else if (key === "QB") {
              if (tau < handoffTau) steer(b, { x: los - 4.3, y: cy }, 4, 0.2);
              else steer(b, { x: los - 6.5, y: cy - 2 }, 3, 0.4);
            } else if (key === "TE") {
              const s0 = start.TE;
              place(b, { x: s0.x + 1.5 * Math.min(1, tau / 0.9), y: s0.y });
            } else {
              const r = routes.get(key);
              if (r) place(b, routeAt(r, tau));
            }
          }
        } else {
          const qb = get("QB");
          if (role === "DL") {
            if (carrierBody && (playType === "run" ? tau > 1.1 : tau > throwTau + 0.3)) {
              steer(b, lead(carrierBody, 0.4), 4.5, 0.35);
            } else if (playType === "pass" && tau > throwTau + 0.3) {
              steer(b, arrivePoint, 4.2, 0.4);
            } else {
              const blockLine = playType === "pass" ? los - 2.0 : los + 1.0;
              steer(b, { x: qb.pos.x, y: qb.pos.y }, 3.2, 0.5, 5);
              if (tau < 2.4 && b.pos.x < blockLine) b.pos.x = blockLine;
            }
          } else if (playType === "run") {
            const react = role === "LB" ? 0.35 : role === "CB" ? 0.7 : 0.9;
            if (tau > react && carrierBody) {
              steer(b, lead(carrierBody, 0.45), role === "LB" ? 6.2 : 7.2, 0.35);
            } else if (role === "CB") {
              const mark = key === "CB1" ? get("X") : key === "CB2" ? get("Z") : get("SL");
              steer(b, { x: mark.pos.x + 2, y: mark.pos.y }, 6, 0.4);
            } else {
              brake(b);
            }
          } else {
            const afterThrow = tau > throwTau + (role === "CB" ? 0.25 : 0.35);
            if (caught && tau >= arriveTau && carrierBody) {
              steer(b, lead(carrierBody, 0.5), 8.2, 0.3);
            } else if (afterThrow) {
              steer(b, arrivePoint, role === "LB" ? 6.5 : 8.4, 0.35);
            } else if (role === "CB") {
              const mark = key === "CB1" ? get("X") : key === "CB2" ? get("Z") : get("SL");
              const cushion = Math.max(0.6, 2.2 - 0.6 * tau);
              const lag = key === "CB1" ? 0.35 : key === "CB2" ? 0.45 : 0.4;
              steer(b, { x: mark.pos.x + cushion, y: mark.pos.y }, 8.6, lag);
            } else if (role === "LB") {
              const s0 = start[key];
              steer(b, { x: los + 8, y: s0.y + (cy - s0.y) * 0.3 }, 5.5, 0.4);
            } else {
              const deepest = Math.max(...["X", "Z", "SL", "TE"].map((k) => get(k).pos.x));
              const s0 = start[key];
              steer(b, { x: Math.max(los + 13, deepest + 4), y: s0.y }, 6.2, 0.5);
            }
          }
        }
      }

      /* ball */
      if (playType === "pass") {
        if (tau < (shotgun ? 0.35 : 0.1)) {
          const qb = get("QB").pos;
          const k = Math.min(1, tau / (shotgun ? 0.35 : 0.1));
          ball = { x: los - 0.3 + (qb.x - (los - 0.3)) * k, y: cy + (qb.y - cy) * k };
        } else if (tau < throwTau) {
          ball = { ...get("QB").pos };
        } else if (tau < arriveTau) {
          const from = qbPass(start.QB, shotgun, throwTau);
          const k = (tau - throwTau) / (arriveTau - throwTau);
          ball = { x: from.x + (arrivePoint.x - from.x) * k, y: from.y + (arrivePoint.y - from.y) * k };
        } else if (caught) {
          ball = { ...get(targetKey).pos };
        } else {
          const from = qbPass(start.QB, shotgun, throwTau);
          const dx = arrivePoint.x - from.x;
          const dy = arrivePoint.y - from.y;
          const d = Math.hypot(dx, dy) || 1;
          const k = Math.min(1, (tau - arriveTau) / 0.25);
          ball = { x: clampX(arrivePoint.x + (dx / d) * 2 * k), y: clampY(arrivePoint.y + (dy / d) * 2 * k) };
        }
      } else {
        if (tau < 0.3 && shotgun) {
          const qb = get("QB").pos;
          const k = tau / 0.3;
          ball = { x: los - 0.3 + (qb.x - (los - 0.3)) * k, y: cy + (qb.y - cy) * k };
        } else {
          const carrier = carrierKey(tau);
          if (carrier && !(tackleTau !== null && tau > tackleTau + 0.2)) ball = { ...get(carrier).pos };
        }
      }
    }
    for (const b of bodies) {
      b.xs.push(b.pos.x);
      b.ys.push(b.pos.y);
    }
    ballX.push(ball.x);
    ballY.push(ball.y);
  }

  /* ---- events ---- */
  const frameOf = (tau: number) => Math.min(totalFrames - 1, snapIdx + Math.round(tau / DT));
  const events: Array<{ index: number; event: string }> = [{ index: 0, event: "line_set" }];
  if (special !== "no_snap_event") events.push({ index: snapIdx, event: "ball_snap" });
  if (playType === "pass") {
    events.push({ index: frameOf(throwTau), event: "pass_forward" });
    events.push({ index: frameOf(arriveTau), event: "pass_arrived" });
    events.push({ index: Math.min(totalFrames - 1, frameOf(arriveTau) + 1), event: caught ? "pass_outcome_caught" : "pass_outcome_incomplete" });
    if (caught && tackleTau !== null) events.push({ index: frameOf(tackleTau), event: "tackle" });
  } else {
    events.push({ index: frameOf(handoffTau), event: "handoff" });
    if (tackleTau !== null) events.push({ index: frameOf(tackleTau), event: "tackle" });
  }

  /* ---- outcome and supplied description ---- */
  const target = get(targetKey);
  const finalBall = ballX[ballX.length - 1];
  const gain = playType === "pass" && !caught ? 0 : Math.round(finalBall - los);
  const jersey = target.entry.ref.jersey;
  const offense = TEAMS[offTeam];
  const defense = TEAMS[defTeam];
  let description: string | null;
  if (playType === "pass") {
    const depth = arrivePoint.x - los > 15 ? "deep" : "short";
    const side = sideWord(arrivePoint.y - cy);
    const formation = shotgun ? "Shotgun" : "Under center";
    description = caught
      ? `(${formation}) Pass ${depth} ${side} to #${jersey} for ${gain} yd`
      : `(${formation}) Pass ${depth} ${side} intended for #${jersey}, incomplete`;
  } else {
    const side = sideWord((get("RB").ys[get("RB").ys.length - 1] ?? cy) - cy);
    description = `Run ${side} by #${jersey} for ${gain} yd`;
  }
  let outcomeYards: number | null = gain;
  if (special === "no_description") {
    description = null;
    outcomeYards = null;
  }

  const yardline = fromGoal === 50 ? "50" : fromGoal < 50 ? `${offense} ${fromGoal}` : `${defense} ${100 - fromGoal}`;

  const missing = new Set<number>();
  if (special === "gap") for (let i = snapIdx + 18; i <= snapIdx + 22 && i < totalFrames; i++) missing.add(i);
  const dropout = new Map<number, number>();
  if (special === "dropout") {
    const cb2 = bodies.findIndex((b) => b.entry.slot.key === "CB2");
    dropout.set(cb2, Math.min(totalFrames - 1, snapIdx + 25));
  }

  const observed = totalFrames - missing.size;
  const refs = bodies.map((b) => b.entry.ref);
  const summary: PlaySummary = {
    id: playId,
    game_id: gameIndex + 1,
    play_id: seq,
    season: game.season,
    week: game.week,
    game_date: game.date,
    home_team: TEAMS[game.home],
    away_team: TEAMS[game.away],
    offense,
    defense,
    quarter,
    game_clock: clock,
    down,
    yards_to_go: ytg,
    yardline_label: yardline,
    play_type: playType,
    description,
    // The simulator models movement only; it invents no formation, coverage, or charting labels.
    context: {
      offense_formation: null,
      receiver_alignment: null,
      defenders_in_the_box: null,
      home_score: null,
      visitor_score: null,
      home_win_probability: null,
      visitor_win_probability: null,
      expected_points: null,
    },
    annotations: {
      coverage_family: null,
      coverage_type: null,
      target_route: null,
      play_action: null,
      dropback_type: null,
      dropback_distance: null,
      pass_location_type: null,
    },
    outcome: {
      pass_result: playType === "pass" && special !== "no_description" ? (caught ? "C" : "I") : null,
      pass_length: null,
      yards_gained: outcomeYards,
      pre_penalty_yards_gained: null,
      penalty_yards: null,
      nullified_by_penalty: null,
      expected_points_added: null,
      home_win_probability_added: null,
      visitor_win_probability_added: null,
    },
    tracking: {
      observed_frame_count: observed,
      observed_duration_s: Math.round((totalFrames - 1) * DT * 1000) / 1000,
      first_frame_id: 1,
      last_frame_id: totalFrames,
      player_count: refs.length,
      offense_player_count: refs.filter((r) => r.side === "offense").length,
      defense_player_count: refs.filter((r) => r.side === "defense").length,
      predicted_player_count: 0,
      future_frame_count: 0,
      future_duration_s: 0,
      ball_tracked: special !== "no_ball",
    },
  };

  return {
    index,
    summary,
    direction,
    los,
    cy,
    firstDown: los + ytg >= 110 ? null : los + ytg,
    frameCount: totalFrames,
    snapIndex: snapIdx,
    events,
    refs,
    roles: bodies.map((b) => b.entry.slot.role),
    xs: bodies.map((b) => b.xs),
    ys: bodies.map((b) => b.ys),
    ballX,
    ballY,
    special,
    missing,
    dropout,
    noiseSeed: hashString(`noise:${seedKey(gameIndex, seq)}`),
  };
}

function qbPass(s: Vec, shotgun: boolean, tau: number): Vec {
  const depth = shotgun ? 2.0 : 5.0;
  const dur = shotgun ? 0.7 : 1.1;
  const k = Math.min(1, tau / dur);
  const e = 1 - (1 - k) * (1 - k);
  return { x: s.x - depth * e, y: s.y + Math.sin(tau * 0.9) * 0.35 };
}

export const GAME_COUNT = GAMES.length;
