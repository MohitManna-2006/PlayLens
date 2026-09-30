import { describe, expect, it } from "vitest";
import type { TrackingSeries } from "@/lib/tracking/series";
import { align, phaseAvailable } from "./alignment";

function fake(times: number[], events: Array<[number, "snap" | "throw" | "arrival"]>): TrackingSeries {
  const idx = (t: number) => times.indexOf(t);
  const ev = events.map(([t, kind]) => ({ index: idx(t), frameId: idx(t) + 1, time: t, code: kind, label: kind, kind }));
  const snap = ev.find((e) => e.kind === "snap");
  return {
    playId: "x",
    direction: "right",
    frameRate: 10,
    frameIds: times.map((_, i) => i + 1),
    times,
    tracks: [],
    ball: null,
    gaps: [],
    events: ev,
    snapIndex: snap ? snap.index : null,
    losX: null,
    firstDownX: null,
  };
}

const range = (a: number, b: number) => Array.from({ length: Math.round((b - a) * 10) + 1 }, (_, i) => Math.round((a + i * 0.1) * 10) / 10);

describe("compare alignment", () => {
  it("aligns on each play's snap by default", () => {
    const l = fake(range(0, 5), [[1, "snap"]]);
    const r = fake(range(0, 6), [[1.5, "snap"]]);
    const a = align(l, r, "snap");
    expect(a.mode).toBe("snap");
    expect(a.toLeft(0)).toBeCloseTo(1);
    expect(a.toRight(0)).toBeCloseTo(1.5);
    expect(a.domain[0]).toBeCloseTo(-1.5);
    expect(a.domain[1]).toBeCloseTo(4.5);
  });

  it("switches both plays to recording start when a snap is missing, and says why", () => {
    const l = fake(range(0, 5), [[1, "snap"]]);
    const r = fake(range(0, 6), []);
    const a = align(l, r, "snap");
    expect(a.mode).toBe("start");
    expect(a.fallbackReason).toMatch(/right play has no snap/);
    expect(a.toLeft(2)).toBeCloseTo(2);
    expect(a.toRight(2)).toBeCloseTo(2);
  });

  it("maps supplied anchors piecewise-linearly in phase mode", () => {
    const l = fake(range(0, 5), [[1, "snap"], [3, "throw"], [4, "arrival"]]);
    const r = fake(range(0, 6), [[1, "snap"], [4, "throw"], [5, "arrival"]]);
    expect(phaseAvailable(l, r)).toBe(true);
    const a = align(l, r, "phase");
    expect(a.mode).toBe("phase");
    expect(a.toRight(2)).toBeCloseTo(4); // left throw (τ=2) ↔ right throw
    expect(a.toRight(1)).toBeCloseTo(2.5); // halfway between snap and throw
  });

  it("does not offer phase alignment without anchors", () => {
    const l = fake(range(0, 5), [[1, "snap"]]);
    const r = fake(range(0, 6), [[1, "snap"], [3, "throw"], [4, "arrival"]]);
    const a = align(l, r, "phase");
    expect(a.mode).toBe("snap");
    expect(a.fallbackReason).toMatch(/Phase alignment needs/);
  });
});
