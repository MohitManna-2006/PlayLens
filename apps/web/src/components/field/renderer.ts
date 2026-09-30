/**
 * Canvas renderer for the football field (§12). Positions and paths are
 * field-based; token sizes, strokes, and text are screen-based. Layer order,
 * back to front: surface → markings → uncertainty → relationships/regions →
 * trails and paths → ball and tokens → rings → labels. Focus and interaction
 * controls are HTML layered above the canvas.
 */
import type { HalfPlane } from "@/lib/contracts";
import {
  END_ZONE,
  FIELD_LENGTH,
  FIELD_WIDTH,
  HASH_FROM_SIDELINE,
  toDisplay,
  velocityFromAngle,
  worldToScreen,
  type Point,
  type Viewport,
} from "@/lib/tracking/geometry";
import { knnGraph, nearestOpponent, trailRange } from "@/lib/tracking/measures";
import { gapAfter, isPresent, type TrackingSeries } from "@/lib/tracking/series";

export const C = {
  surround: "#171A1D",
  field: "#142923",
  endZone: "#10221D",
  line: "#728D81",
  label: "#A8BCB2",
  chalk: "#F2F4F5",
  dark: "#101214",
  accent: "#E7B66B",
  neutral: "#B7C0C8",
  error: "#F09494",
};

export type RelationshipLayer = "none" | "nearest_opponent" | "interaction_graph";

export interface OverlayState {
  trails: boolean;
  velocity: "off" | "selected" | "all";
  acceleration: boolean;
  relationship: RelationshipLayer;
  graphAll: boolean;
}

export const DEFAULT_OVERLAYS: OverlayState = {
  trails: false,
  velocity: "off",
  acceleration: false,
  relationship: "none",
  graphAll: false,
};

export interface ForecastLayer {
  playerIndex: number;
  origin: Point;
  path: Point[];
  valid: boolean[];
  samples: Point[][] | null;
  showUncertainty: boolean;
  observedFuture: Point[] | null;
}

export interface PlayLabLayer {
  editIndex: number | null;
  original: Point | null;
  proposed: Point | null;
  invalid: boolean;
  region: Point[] | null;
  eligible: Set<number>;
  focusIndex: number | null;
  originalPath: Point[] | null;
  modifiedPath: Point[] | null;
  modifiedSamples: Point[][] | null;
  observedFuture: Point[] | null;
}

export interface RenderInput {
  width: number;
  height: number;
  dpr: number;
  vp: Viewport;
  flipped: boolean;
  series: TrackingSeries | null;
  frameIndex: number;
  alpha: number;
  selected: number | null;
  hovered: number | null;
  counterpart: number | null;
  overlays: OverlayState;
  forecast: ForecastLayer | null;
  playlab: PlayLabLayer | null;
  fonts: { mono: string; sans: string };
  ended: boolean;
}

const TOKEN_R = 8;

function crisp(v: number, width: number) {
  return width % 2 === 1 ? Math.round(v) + 0.5 : Math.round(v);
}

/** Display-space screen point for a source-coordinate point. */
function screen(input: RenderInput, p: Point): Point {
  return worldToScreen(input.vp, toDisplay(p.x, p.y, input.flipped));
}

export function playerScreenPosition(input: Pick<RenderInput, "series" | "frameIndex" | "alpha" | "vp" | "flipped" | "playlab">, j: number): Point | null {
  const s = input.series;
  if (!s) return null;
  const t = s.tracks[j];
  const i = input.frameIndex;
  if (!isPresent(t, i)) return null;
  if (input.playlab && input.playlab.editIndex === j && input.playlab.proposed) {
    return worldToScreen(input.vp, toDisplay(input.playlab.proposed.x, input.playlab.proposed.y, input.flipped));
  }
  let x = t.x[i];
  let y = t.y[i];
  if (input.alpha > 0 && i + 1 < s.times.length && isPresent(t, i + 1) && !gapAfter(s, i)) {
    x += (t.x[i + 1] - x) * input.alpha;
    y += (t.y[i + 1] - y) * input.alpha;
  }
  return worldToScreen(input.vp, toDisplay(x, y, input.flipped));
}

function ballScreenPosition(input: RenderInput): Point | null {
  const s = input.series;
  if (!s?.ball) return null;
  const i = input.frameIndex;
  let x = s.ball.x[i];
  let y = s.ball.y[i];
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  if (input.alpha > 0 && i + 1 < s.times.length && Number.isFinite(s.ball.x[i + 1]) && !gapAfter(s, i)) {
    x += (s.ball.x[i + 1] - x) * input.alpha;
    y += (s.ball.y[i + 1] - y) * input.alpha;
  }
  return screen(input, { x, y });
}

function drawField(ctx: CanvasRenderingContext2D, input: RenderInput) {
  const { vp } = input;
  const tl = worldToScreen(vp, { x: 0, y: FIELD_WIDTH });
  const br = worldToScreen(vp, { x: FIELD_LENGTH, y: 0 });
  ctx.fillStyle = C.field;
  ctx.fillRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);
  ctx.fillStyle = C.endZone;
  const ez = END_ZONE * vp.scale;
  ctx.fillRect(tl.x, tl.y, ez, br.y - tl.y);
  ctx.fillRect(br.x - ez, tl.y, ez, br.y - tl.y);

  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let x = END_ZONE; x <= FIELD_LENGTH - END_ZONE; x += 5) {
    const sx = crisp(vp.ox + x * vp.scale, 1);
    ctx.moveTo(sx, tl.y);
    ctx.lineTo(sx, br.y);
  }
  ctx.stroke();

  if (vp.scale >= 3) {
    ctx.beginPath();
    const tick = 0.67;
    const hashes = [HASH_FROM_SIDELINE, FIELD_WIDTH - HASH_FROM_SIDELINE];
    for (let x = END_ZONE + 1; x < FIELD_LENGTH - END_ZONE; x++) {
      if (x % 5 === 0) continue;
      const sx = crisp(vp.ox + x * vp.scale, 1);
      for (const [a, b] of [
        [0.33, 0.33 + tick],
        [FIELD_WIDTH - 0.33 - tick, FIELD_WIDTH - 0.33],
        [hashes[0] - tick / 2, hashes[0] + tick / 2],
        [hashes[1] - tick / 2, hashes[1] + tick / 2],
      ]) {
        ctx.moveTo(sx, vp.oy - a * vp.scale);
        ctx.lineTo(sx, vp.oy - b * vp.scale);
      }
    }
    ctx.stroke();
  }

  ctx.lineWidth = 1.5;
  ctx.strokeRect(tl.x, tl.y, br.x - tl.x, br.y - tl.y);

  // Yard numbers: upright, fewer at small scales.
  const every = 10 * vp.scale < 36 ? 20 : 10;
  ctx.fillStyle = C.label;
  ctx.font = `400 12px ${input.fonts.mono}`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let yd = 10; yd <= 90; yd += every) {
    const x = END_ZONE + yd;
    const label = String(yd <= 50 ? yd : 100 - yd);
    const sx = vp.ox + x * vp.scale;
    const bottom = vp.oy - 7 * vp.scale;
    const top = vp.oy - (FIELD_WIDTH - 7) * vp.scale;
    if (vp.scale * 7 > 14) {
      ctx.fillText(label, sx, bottom);
      ctx.fillText(label, sx, top);
    }
  }
}

function drawScrimmage(ctx: CanvasRenderingContext2D, input: RenderInput) {
  const s = input.series;
  if (!s) return;
  const { vp } = input;
  const top = vp.oy - FIELD_WIDTH * vp.scale;
  const bottom = vp.oy;
  const line = (x: number, dashed: boolean) => {
    const sx = crisp(screen(input, { x, y: 0 }).x, 1);
    ctx.save();
    ctx.strokeStyle = C.neutral;
    ctx.lineWidth = 1;
    if (dashed) ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(sx, top);
    ctx.lineTo(sx, bottom);
    ctx.stroke();
    ctx.restore();
    return sx;
  };
  if (s.losX !== null) line(s.losX, false);
  if (s.firstDownX !== null) line(s.firstDownX, true);
}

function drawScrimmageLabels(ctx: CanvasRenderingContext2D, input: RenderInput) {
  const s = input.series;
  if (!s) return;
  // Top edge; drop below the HTML orientation label at top-left, and stack
  // "To gain" under "LOS" when the two lines are close.
  const base = Math.max(4, input.vp.oy - FIELD_WIDTH * input.vp.scale) + 4;
  const losX = s.losX !== null ? screen(input, { x: s.losX, y: 0 }).x : null;
  const label = (x: number, text: string) => {
    const sx = screen(input, { x, y: 0 }).x;
    let top = sx < 240 ? base + 26 : base;
    if (text !== "LOS" && losX !== null && Math.abs(sx - losX) < 64) top += 18;
    ctx.font = `500 11px ${input.fonts.mono}`;
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = C.field;
    ctx.fillRect(sx - w / 2, top, w, 16);
    ctx.fillStyle = C.label;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, sx, top + 8);
  };
  if (s.losX !== null) label(s.losX, "LOS");
  if (s.firstDownX !== null) label(s.firstDownX, "To gain");
}

function polyline(ctx: CanvasRenderingContext2D, input: RenderInput, pts: Point[], from?: Point) {
  ctx.beginPath();
  let started = false;
  if (from) {
    const p = screen(input, from);
    ctx.moveTo(p.x, p.y);
    started = true;
  }
  for (const q of pts) {
    const p = screen(input, q);
    if (!started) {
      ctx.moveTo(p.x, p.y);
      started = true;
    } else ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
}

function arrow(ctx: CanvasRenderingContext2D, from: Point, to: Point, width: number, dashed: boolean, color: string) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 3) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = width;
  if (dashed) ctx.setLineDash([4, 3]);
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
  ctx.setLineDash([]);
  const ux = dx / len;
  const uy = dy / len;
  const h = 6;
  ctx.beginPath();
  ctx.moveTo(to.x, to.y);
  ctx.lineTo(to.x - ux * h - uy * 3.5, to.y - uy * h + ux * 3.5);
  ctx.lineTo(to.x - ux * h + uy * 3.5, to.y - uy * h - ux * 3.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/** Screen-space direction of an NGS velocity at a source point. */
function velocityScreen(input: RenderInput, s: number, dir: number, seconds: number): Point {
  const v = velocityFromAngle(s, dir);
  const f = input.flipped ? -1 : 1;
  return { x: v.x * f * seconds * input.vp.scale, y: -v.y * f * seconds * input.vp.scale };
}

function labelBox(ctx: CanvasRenderingContext2D, input: RenderInput, text: string, x: number, y: number, color = C.chalk, size = 12) {
  ctx.font = `500 ${size}px ${input.fonts.mono}`;
  const w = ctx.measureText(text).width + 8;
  const h = size + 6;
  const bx = Math.min(input.width - w - 2, Math.max(2, x));
  const by = Math.min(input.height - h - 2, Math.max(2, y));
  ctx.fillStyle = C.field;
  ctx.fillRect(bx, by, w, h);
  ctx.fillStyle = color;
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(text, bx + 4, by + h / 2 + 0.5);
}

function diamond(ctx: CanvasRenderingContext2D, p: Point, w: number, h: number) {
  ctx.beginPath();
  ctx.moveTo(p.x, p.y - h / 2);
  ctx.lineTo(p.x + w / 2, p.y);
  ctx.lineTo(p.x, p.y + h / 2);
  ctx.lineTo(p.x - w / 2, p.y);
  ctx.closePath();
}

function ring(ctx: CanvasRenderingContext2D, p: Point, r: number, width: number, color: string, dash: number[] = []) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.setLineDash(dash);
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function validPrefix(path: Point[], valid: boolean[]): Point[] {
  const out: Point[] = [];
  for (let k = 0; k < path.length; k++) {
    if (!valid[k]) break;
    out.push(path[k]);
  }
  return out;
}

export function render(ctx: CanvasRenderingContext2D, input: RenderInput) {
  const { width, height, dpr, series: s, frameIndex: i } = input;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = C.surround;
  ctx.fillRect(0, 0, width, height);

  drawField(ctx, input);
  if (!s) return;
  drawScrimmage(ctx, input);

  const pos: Array<Point | null> = s.tracks.map((_, j) => playerScreenPosition(input, j));
  const sel = input.selected;

  /* 3. uncertainty */
  const f = input.forecast;
  if (f && f.showUncertainty && f.samples) {
    ctx.save();
    ctx.strokeStyle = "rgba(231,182,107,0.16)";
    ctx.lineWidth = 1;
    for (const sample of f.samples) polyline(ctx, input, sample, f.origin);
    ctx.fillStyle = "rgba(231,182,107,0.55)";
    for (const sample of f.samples) {
      const end = sample[sample.length - 1];
      if (!end) continue;
      const p = screen(input, end);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  const pl = input.playlab;
  if (pl?.modifiedSamples && pl.modifiedPath && pl.proposed) {
    ctx.save();
    ctx.strokeStyle = "rgba(231,182,107,0.16)";
    ctx.lineWidth = 1;
    for (const sample of pl.modifiedSamples) polyline(ctx, input, sample, pl.proposed);
    ctx.restore();
  }

  /* 4. relationships and regions */
  if (pl?.region && pl.region.length > 2) {
    ctx.save();
    ctx.beginPath();
    pl.region.forEach((q, k) => {
      const p = screen(input, q);
      if (k === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    });
    ctx.closePath();
    ctx.fillStyle = "rgba(242,244,245,0.05)";
    ctx.fill();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = "rgba(183,192,200,0.85)";
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  const rel = input.overlays.relationship;
  if (rel === "interaction_graph" && (sel !== null || input.overlays.graphAll)) {
    const edges = knnGraph(s, i, 3);
    ctx.save();
    ctx.lineWidth = 1;
    for (const e of edges) {
      const a = pos[e.a];
      const b = pos[e.b];
      if (!a || !b) continue;
      const incident = sel !== null && (e.a === sel || e.b === sel);
      if (!incident && !input.overlays.graphAll) continue;
      ctx.strokeStyle = incident ? C.neutral : "rgba(183,192,200,0.35)";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    ctx.restore();
  }
  let nearestLabel: { text: string; x: number; y: number } | null = null;
  if (rel === "nearest_opponent" && sel !== null && pos[sel]) {
    const n = nearestOpponent(s, sel, i);
    const b = n ? pos[n.playerIndex] : null;
    if (n && b) {
      const a = pos[sel]!;
      ctx.save();
      ctx.strokeStyle = C.neutral;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([1.5, 3]);
      ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
      nearestLabel = { text: `${n.distance.toFixed(1)} yd`, x: (a.x + b.x) / 2 + 6, y: (a.y + b.y) / 2 - 18 };
    }
  }

  /* 5. trails and paths */
  if (input.overlays.trails) {
    ctx.save();
    ctx.strokeStyle = "rgba(242,244,245,0.45)";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";
    s.tracks.forEach((t, j) => {
      const r = trailRange(s, j, i, 1);
      if (!r) return;
      const pts: Point[] = [];
      for (let k = r[0]; k <= r[1]; k++) pts.push({ x: t.x[k], y: t.y[k] });
      polyline(ctx, input, pts);
    });
    ctx.restore();
  }

  const drawObservedFuture = (pts: Point[], from: Point) => {
    if (!pts.length) return;
    ctx.save();
    ctx.strokeStyle = C.chalk;
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    polyline(ctx, input, pts, from);
    const end = screen(input, pts[pts.length - 1]);
    ctx.fillStyle = C.chalk;
    ctx.fillRect(end.x - 3.5, end.y - 3.5, 7, 7);
    ctx.restore();
  };
  const drawPredicted = (pts: Point[], from: Point, color: string) => {
    if (!pts.length) return;
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.lineJoin = "round";
    polyline(ctx, input, pts, from);
    ctx.setLineDash([]);
    const end = screen(input, pts[pts.length - 1]);
    ctx.fillStyle = color;
    ctx.strokeStyle = C.dark;
    ctx.lineWidth = 1;
    diamond(ctx, end, 9, 9);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  };

  if (f) {
    if (f.observedFuture) drawObservedFuture(f.observedFuture, f.origin);
    drawPredicted(validPrefix(f.path, f.valid), f.origin, C.accent);
  }
  if (pl) {
    if (pl.observedFuture && pl.original) drawObservedFuture(pl.observedFuture, pl.original);
    if (pl.originalPath && pl.original) drawPredicted(pl.originalPath, pl.original, "rgba(183,192,200,0.9)");
    if (pl.modifiedPath && pl.proposed) drawPredicted(pl.modifiedPath, pl.proposed, C.accent);
    if (pl.original && pl.proposed && pl.editIndex !== null) {
      const a = screen(input, pl.original);
      const b = screen(input, pl.proposed);
      if (Math.hypot(a.x - b.x, a.y - b.y) > TOKEN_R * 2) {
        ctx.save();
        ctx.strokeStyle = "rgba(242,244,245,0.6)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        ctx.restore();
      }
    }
  }

  // Velocity / acceleration arrows (observed, chalk).
  const vScope = input.overlays.velocity;
  s.tracks.forEach((t, j) => {
    const p = pos[j];
    if (!p) return;
    const isSel = j === sel;
    if (isSel && input.overlays.acceleration) {
      const a0 = Math.max(0, i - 1);
      const a1 = Math.min(s.times.length - 1, i + 1);
      if (a1 > a0 && [a0, a1].every((k) => Number.isFinite(t.s[k]) && Number.isFinite(t.dir[k]))) {
        const v0 = velocityFromAngle(t.s[a0], t.dir[a0]);
        const v1 = velocityFromAngle(t.s[a1], t.dir[a1]);
        const dt = s.times[a1] - s.times[a0];
        const ax = (v1.x - v0.x) / dt;
        const ay = (v1.y - v0.y) / dt;
        const flip = input.flipped ? -1 : 1;
        arrow(ctx, p, { x: p.x + ax * flip * input.vp.scale, y: p.y - ay * flip * input.vp.scale }, 1, true, C.chalk);
      }
      return;
    }
    if (vScope === "all" || (vScope === "selected" && isSel)) {
      if (!Number.isFinite(t.s[i]) || !Number.isFinite(t.dir[i])) return;
      const d = velocityScreen(input, t.s[i], t.dir[i], 1);
      arrow(ctx, p, { x: p.x + d.x, y: p.y + d.y }, 1.5, false, C.chalk);
    }
  });

  /* 6. ball and tokens */
  const ball = ballScreenPosition(input);
  if (ball) {
    ctx.save();
    ctx.fillStyle = C.chalk;
    ctx.strokeStyle = C.dark;
    ctx.lineWidth = 1;
    diamond(ctx, ball, 8, 10);
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  if (pl?.original && pl.editIndex !== null) {
    const g = screen(input, pl.original);
    ring(ctx, g, TOKEN_R, 1, C.chalk, [3, 2]);
  }

  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  s.tracks.forEach((t, j) => {
    const p = pos[j];
    if (!p) return;
    const offense = t.ref.side === "offense";
    const edited = pl && pl.editIndex === j && pl.proposed;
    ctx.beginPath();
    ctx.arc(p.x, p.y, TOKEN_R, 0, Math.PI * 2);
    if (edited) {
      ctx.fillStyle = C.accent;
      ctx.fill();
      ctx.strokeStyle = pl.invalid ? C.error : C.dark;
      ctx.lineWidth = pl.invalid ? 2 : 1;
      ctx.stroke();
    } else if (offense) {
      ctx.fillStyle = C.chalk;
      ctx.fill();
      ctx.strokeStyle = C.dark;
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      ctx.fillStyle = C.dark;
      ctx.fill();
      ctx.strokeStyle = C.chalk;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, TOKEN_R - 1, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (t.ref.jersey) {
      ctx.font = `500 ${t.ref.jersey.length > 2 ? 8 : 10}px ${input.fonts.mono}`;
      ctx.fillStyle = edited || offense ? C.dark : C.chalk;
      ctx.fillText(t.ref.jersey, p.x, p.y + 0.5);
    }
  });

  if (pl?.invalid && pl.editIndex !== null && pos[pl.editIndex]) {
    const p = pos[pl.editIndex]!;
    const g = { x: p.x + 13, y: p.y - 13 };
    ctx.save();
    ctx.fillStyle = C.dark;
    ctx.beginPath();
    ctx.arc(g.x, g.y, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = C.error;
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(g.x - 3.5, g.y + 3.5);
    ctx.lineTo(g.x + 3.5, g.y - 3.5);
    ctx.stroke();
    ctx.restore();
  }

  /* 7. rings */
  if (input.hovered !== null && input.hovered !== sel && pos[input.hovered]) {
    ring(ctx, pos[input.hovered]!, TOKEN_R + 2.5, 1, pl ? C.neutral : C.chalk);
  }
  if (pl && pl.focusIndex !== null && pos[pl.focusIndex] && pl.focusIndex !== pl.editIndex) {
    ring(ctx, pos[pl.focusIndex]!, TOKEN_R + 2.5, 1, C.neutral);
  }
  if (input.counterpart !== null && pos[input.counterpart]) {
    ring(ctx, pos[input.counterpart]!, TOKEN_R + 3.5, 1, C.accent);
  }
  if (sel !== null && pos[sel]) {
    ring(ctx, pos[sel]!, TOKEN_R + 4, 2, C.accent);
  }

  /* 8. labels */
  drawScrimmageLabels(ctx, input);
  if (nearestLabel) labelBox(ctx, input, nearestLabel.text, nearestLabel.x, nearestLabel.y, C.chalk, 12);
  if (f && f.path.length) {
    const pts = validPrefix(f.path, f.valid);
    if (pts.length) {
      const e = screen(input, pts[pts.length - 1]);
      labelBox(ctx, input, "Predicted", e.x + 8, e.y - 9, C.accent, 11);
    }
    if (f.observedFuture?.length) {
      const e = screen(input, f.observedFuture[f.observedFuture.length - 1]);
      labelBox(ctx, input, "Observed", e.x + 8, e.y + 6, C.chalk, 11);
    }
  }
  if (pl) {
    if (pl.original && pl.editIndex !== null && pl.proposed) {
      const g = screen(input, pl.original);
      const moved = Math.hypot(pl.original.x - pl.proposed.x, pl.original.y - pl.proposed.y) > 0.05;
      if (moved) labelBox(ctx, input, "Original", g.x - 30, g.y + 12, C.chalk, 11);
    }
    if (pl.originalPath?.length) {
      const e = screen(input, pl.originalPath[pl.originalPath.length - 1]);
      labelBox(ctx, input, "Original", e.x + 8, e.y + 4, C.neutral, 11);
    }
    if (pl.modifiedPath?.length) {
      const e = screen(input, pl.modifiedPath[pl.modifiedPath.length - 1]);
      labelBox(ctx, input, "Modified", e.x + 8, e.y - 18, C.accent, 11);
    }
  }
  const labelFor = (j: number, color: string) => {
    const p = pos[j];
    if (!p) return;
    const r = s.tracks[j].ref;
    const text = [r.jersey ? `#${r.jersey}` : null, r.position].filter(Boolean).join(" ") || r.player_id;
    labelBox(ctx, input, text, p.x + 14, p.y - 26, color, 12);
  };
  if (input.hovered !== null && input.hovered !== sel) labelFor(input.hovered, C.chalk);
  if (sel !== null) labelFor(sel, C.chalk);

  if (input.ended) {
    ctx.save();
    ctx.font = `500 12px ${input.fonts.sans}`;
    labelBox(ctx, input, "Ended · holding last frame", 8, input.height - 26, C.chalk, 12);
    ctx.restore();
  }
}

/* ------------------------------------------------------------------ */

/** Allowed PlayLab region: circle ∩ field ∩ half-planes, as a polygon (source coords). */
export function allowedRegion(
  center: Point,
  radius: number,
  bounds: { x_min: number; x_max: number; y_min: number; y_max: number },
  planes: HalfPlane[],
): Point[] {
  let poly: Point[] = [];
  for (let k = 0; k < 96; k++) {
    const a = (k / 96) * Math.PI * 2;
    poly.push({ x: center.x + Math.cos(a) * radius, y: center.y + Math.sin(a) * radius });
  }
  const clip = (nx: number, ny: number, c: number) => {
    const out: Point[] = [];
    for (let k = 0; k < poly.length; k++) {
      const a = poly[k];
      const b = poly[(k + 1) % poly.length];
      const da = nx * a.x + ny * a.y - c;
      const db = nx * b.x + ny * b.y - c;
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) {
        const t = da / (da - db);
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    poly = out;
  };
  clip(1, 0, bounds.x_min);
  clip(-1, 0, -bounds.x_max);
  clip(0, 1, bounds.y_min);
  clip(0, -1, -bounds.y_max);
  for (const h of planes) clip(h.nx, h.ny, h.c);
  return poly;
}
