/**
 * Field geometry and the orientation display transform.
 *
 * Stored coordinates are canonical yards (x ∈ [0, 120] including both 10 yd end
 * zones, y ∈ [0, 53⅓]) with the offense attacking toward +x, as served by the
 * API (Masterbrain §9.1). "Normalized" presentation shows them as stored.
 * "Source" presentation re-applies the recorded orientation: plays recorded
 * moving left are rotated 180° back. The rotation is its own inverse, matches
 * the preprocessing transform exactly, and never touches stored values.
 */
import type { PlayDirection } from "@/lib/contracts";

export const FIELD_LENGTH = 120;
export const FIELD_WIDTH = 160 / 3;
export const END_ZONE = 10;
/** NFL hash marks sit 70 ft 9 in from each sideline. */
export const HASH_FROM_SIDELINE = 70.75 / 3;

export type Orientation = "normalized" | "source";

export interface Point {
  x: number;
  y: number;
}

export interface Extent {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

export const FULL_FIELD: Extent = { x0: 0, x1: FIELD_LENGTH, y0: 0, y1: FIELD_WIDTH };

/**
 * True when the display must rotate stored (canonical) coordinates by 180°:
 * only in Source view for plays recorded moving left.
 */
export function isFlipped(direction: PlayDirection | null, orientation: Orientation): boolean {
  return orientation === "source" && direction === "left";
}

/** Stored (canonical) coordinates → display coordinates. */
export function toDisplay(x: number, y: number, flipped: boolean): Point {
  return flipped ? { x: FIELD_LENGTH - x, y: FIELD_WIDTH - y } : { x, y };
}

/** Display coordinates → stored (canonical) coordinates; the rotation is an involution. */
export function toSource(x: number, y: number, flipped: boolean): Point {
  return toDisplay(x, y, flipped);
}

/** Recorded (raw) position of a canonical point, given the recorded play direction. */
export function toRecorded(p: Point, direction: PlayDirection | null): Point {
  return toDisplay(p.x, p.y, direction === "left");
}

/** Rotate an NGS angle (0° = +y, clockwise) into display space. */
export function angleToDisplay(deg: number, flipped: boolean): number {
  return flipped ? (deg + 180) % 360 : deg;
}

/** Velocity components (yd/s) from speed and an NGS direction angle. */
export function velocityFromAngle(speed: number, deg: number): Point {
  const r = (deg * Math.PI) / 180;
  return { x: speed * Math.sin(r), y: speed * Math.cos(r) };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function clampToField(e: Extent): Extent {
  return {
    x0: Math.max(0, e.x0),
    x1: Math.min(FIELD_LENGTH, e.x1),
    y0: Math.max(0, e.y0),
    y1: Math.min(FIELD_WIDTH, e.y1),
  };
}

export function unionExtent(a: Extent, b: Extent): Extent {
  return {
    x0: Math.min(a.x0, b.x0),
    x1: Math.max(a.x1, b.x1),
    y0: Math.min(a.y0, b.y0),
    y1: Math.max(a.y1, b.y1),
  };
}

export function padExtent(e: Extent, pad: number): Extent {
  return { x0: e.x0 - pad, x1: e.x1 + pad, y0: e.y0 - pad, y1: e.y1 + pad };
}

/** Isotropic fit: one yard has the same screen length on both axes. */
export interface Viewport {
  width: number;
  height: number;
  scale: number;
  /** Screen x of display x = 0. */
  ox: number;
  /** Screen y of display y = 0 (display y grows upward, screen y downward). */
  oy: number;
}

export function fitViewport(extent: Extent, width: number, height: number, inset = 12): Viewport {
  const w = Math.max(1, extent.x1 - extent.x0);
  const h = Math.max(1, extent.y1 - extent.y0);
  const availW = Math.max(1, width - inset * 2);
  const availH = Math.max(1, height - inset * 2);
  const scale = Math.min(availW / w, availH / h);
  let cx = (extent.x0 + extent.x1) / 2;
  let cy = (extent.y0 + extent.y1) / 2;
  // Keep the visible window on the field when the field can fill it; the
  // required extent is inside the field, so it stays fully visible.
  const halfW = width / 2 / scale;
  const halfH = height / 2 / scale;
  if (halfW * 2 <= FIELD_LENGTH) cx = Math.min(FIELD_LENGTH - halfW, Math.max(halfW, cx));
  if (halfH * 2 <= FIELD_WIDTH) cy = Math.min(FIELD_WIDTH - halfH, Math.max(halfH, cy));
  return {
    width,
    height,
    scale,
    ox: width / 2 - cx * scale,
    oy: height / 2 + cy * scale,
  };
}

export function worldToScreen(vp: Viewport, p: Point): Point {
  return { x: vp.ox + p.x * vp.scale, y: vp.oy - p.y * vp.scale };
}

export function screenToWorld(vp: Viewport, p: Point): Point {
  return { x: (p.x - vp.ox) / vp.scale, y: (vp.oy - p.y) / vp.scale };
}
