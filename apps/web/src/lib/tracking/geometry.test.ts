import { describe, expect, it } from "vitest";
import {
  angleToDisplay,
  FIELD_LENGTH,
  FIELD_WIDTH,
  fitViewport,
  isFlipped,
  screenToWorld,
  toDisplay,
  toRecorded,
  toSource,
  velocityFromAngle,
  worldToScreen,
} from "./geometry";

describe("orientation transform over canonical coordinates", () => {
  it("shows canonical coordinates unchanged in the normalized view", () => {
    expect(isFlipped("left", "normalized")).toBe(false);
    expect(isFlipped("right", "normalized")).toBe(false);
    expect(toDisplay(30, 10, false)).toEqual({ x: 30, y: 10 });
  });

  it("rotates plays recorded moving left by 180° in the source view and round-trips exactly", () => {
    const flipped = isFlipped("left", "source");
    expect(flipped).toBe(true);
    const d = toDisplay(30, 10, flipped);
    expect(d.x).toBeCloseTo(FIELD_LENGTH - 30);
    expect(d.y).toBeCloseTo(FIELD_WIDTH - 10);
    const back = toSource(d.x, d.y, flipped);
    expect(back.x).toBeCloseTo(30);
    expect(back.y).toBeCloseTo(10);
  });

  it("never transforms right-moving plays or plays with unknown direction", () => {
    expect(isFlipped("right", "source")).toBe(false);
    expect(isFlipped(null, "source")).toBe(false);
  });

  it("recovers recorded coordinates from canonical ones (inverse of preprocessing)", () => {
    // Canonical x 67.67 of a left play was recorded at 120 − 67.67 = 52.33.
    const raw = toRecorded({ x: 67.67, y: 16.393333 }, "left");
    expect(raw.x).toBeCloseTo(52.33, 6);
    expect(raw.y).toBeCloseTo(36.94, 5);
    expect(toRecorded({ x: 5, y: 6 }, "right")).toEqual({ x: 5, y: 6 });
  });

  it("rotates NGS angles with the positions", () => {
    expect(angleToDisplay(90, true)).toBe(270);
    expect(angleToDisplay(270, true)).toBe(90);
    const v = velocityFromAngle(2, 90);
    expect(v.x).toBeCloseTo(2);
    expect(v.y).toBeCloseTo(0);
  });
});

describe("isotropic viewport", () => {
  it("uses one scale for both axes and round-trips points", () => {
    const vp = fitViewport({ x0: 0, x1: 120, y0: 0, y1: FIELD_WIDTH }, 1000, 600, 0);
    expect(vp.scale).toBeCloseTo(1000 / 120);
    const s = worldToScreen(vp, { x: 60, y: 20 });
    const w = screenToWorld(vp, s);
    expect(w.x).toBeCloseTo(60);
    expect(w.y).toBeCloseTo(20);
    // display y grows upward
    expect(worldToScreen(vp, { x: 0, y: 10 }).y).toBeLessThan(worldToScreen(vp, { x: 0, y: 0 }).y);
  });
});
