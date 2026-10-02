import { describe, expect, it } from "vitest";
import type { TrackingSeries } from "@/lib/tracking/series";
import { align, phaseAvailable, progressIndex } from "./alignment";
import { masterClock, resync, sideEnded, sideFrameIndex, sideTime, unsync } from "./sync";

function fake(times: number[], events: Array<[number, "snap" | "throw" | "arrival"]> = []): TrackingSeries {
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

describe("normalized progress", () => {
  it("maps progress to round(p × (frames − 1))", () => {
    expect(progressIndex(34, 0)).toBe(0);
    expect(progressIndex(34, 1)).toBe(33);
    expect(progressIndex(34, 0.5)).toBe(17); // 16.5 rounds up
    expect(progressIndex(29, 0.5)).toBe(14);
    expect(progressIndex(1, 0.7)).toBe(0);
    expect(progressIndex(10, 1.4)).toBe(9); // clamped
  });

  it("starts and ends both plays together despite different lengths", () => {
    const l = fake(range(0, 3.3)); // 34 frames
    const r = fake(range(0, 2.8)); // 29 frames
    const a = align(l, r, "progress");
    expect(a.mode).toBe("progress");
    expect(a.domain).toEqual([0, 3.3]);
    expect(a.initial).toBe(0);
    expect(sideFrameIndex(a, l, "left", 0, false)).toBe(0);
    expect(sideFrameIndex(a, r, "right", 0, false)).toBe(0);
    expect(sideFrameIndex(a, l, "left", 3.3, false)).toBe(33);
    expect(sideFrameIndex(a, r, "right", 3.3, false)).toBe(28);
    // Halfway: each play shows its own middle frame.
    expect(sideFrameIndex(a, l, "left", 1.65, false)).toBe(progressIndex(34, 0.5));
    expect(sideFrameIndex(a, r, "right", 1.65, false)).toBe(progressIndex(29, 0.5));
    expect(a.progressAt!(1.65)).toBeCloseTo(0.5);
    expect(sideEnded(a, r, "right", 3.3)).toBe(false);
  });

  it("shows real frames when paused and continuous time while playing", () => {
    const l = fake(range(0, 3.3));
    const r = fake(range(0, 2.8));
    const a = align(l, r, "progress");
    const tau = 1.0; // p = 0.303
    const paused = sideTime(a, r, "right", tau, false);
    expect(r.times).toContain(paused);
    expect(paused).toBeCloseTo(r.times[progressIndex(29, tau / 3.3)]);
    expect(sideTime(a, r, "right", tau, true)).toBeCloseTo((tau / 3.3) * 2.8);
  });
});

describe("last-observed-frame alignment", () => {
  it("brings both plays to their last observed frame at τ = 0, at real speed", () => {
    const l = fake(range(0, 3.3));
    const r = fake(range(0, 2.8));
    const a = align(l, r, "origin");
    expect(a.domain[0]).toBeCloseTo(-3.3);
    expect(a.domain[1]).toBeCloseTo(0);
    expect(a.initial).toBeCloseTo(-3.3);
    expect(sideFrameIndex(a, l, "left", 0, false)).toBe(33);
    expect(sideFrameIndex(a, r, "right", 0, false)).toBe(28);
    // One second before the end, both are one second (10 frames) before their last frame.
    expect(sideFrameIndex(a, l, "left", -1, false)).toBe(23);
    expect(sideFrameIndex(a, r, "right", -1, false)).toBe(18);
    // The shorter play has not started yet at the very beginning.
    expect(sideTime(a, r, "right", -3.3, false)).toBe(0);
  });
});

describe("event alignment (fixture plays)", () => {
  it("aligns on each play's snap", () => {
    const l = fake(range(0, 5), [[1, "snap"]]);
    const r = fake(range(0, 6), [[1.5, "snap"]]);
    const a = align(l, r, "snap");
    expect(a.mode).toBe("snap");
    expect(a.toLeft(0)).toBeCloseTo(1);
    expect(a.toRight(0)).toBeCloseTo(1.5);
    expect(a.domain[0]).toBeCloseTo(-1.5);
    expect(a.domain[1]).toBeCloseTo(4.5);
  });

  it("falls back to normalized progress without snaps, and says why", () => {
    const l = fake(range(0, 5), [[1, "snap"]]);
    const r = fake(range(0, 6));
    const a = align(l, r, "snap");
    expect(a.mode).toBe("progress");
    expect(a.fallbackReason).toMatch(/right play has a snap event|right play has/);
  });

  it("maps supplied anchors piecewise-linearly in phase mode", () => {
    const l = fake(range(0, 5), [[1, "snap"], [3, "throw"], [4, "arrival"]]);
    const r = fake(range(0, 6), [[1, "snap"], [4, "throw"], [5, "arrival"]]);
    expect(phaseAvailable(l, r)).toBe(true);
    const a = align(l, r, "phase");
    expect(a.mode).toBe("phase");
    expect(a.toRight(2)).toBeCloseTo(4);
    expect(a.toRight(1)).toBeCloseTo(2.5);
  });

  it("does not offer phase alignment without anchors", () => {
    const l = fake(range(0, 5), [[1, "snap"]]);
    const r = fake(range(0, 6), [[1, "snap"], [3, "throw"], [4, "arrival"]]);
    const a = align(l, r, "phase");
    expect(a.mode).toBe("snap");
    expect(a.fallbackReason).toMatch(/Phase alignment needs/);
  });
});

describe("sync on and off", () => {
  it("one master clock drives both plays while synced", () => {
    const l = fake(range(0, 3.3));
    const r = fake(range(0, 2.8));
    const a = align(l, r, "progress");
    const master = masterClock(a);
    master.seek(3.3);
    expect(sideFrameIndex(a, l, "left", master.getTime(), false)).toBe(33);
    expect(sideFrameIndex(a, r, "right", master.getTime(), false)).toBe(28);
    master.toStart();
    expect(sideFrameIndex(a, l, "left", master.getTime(), false)).toBe(0);
    expect(sideFrameIndex(a, r, "right", master.getTime(), false)).toBe(0);
    master.dispose();
  });

  it("unsynced clocks start where the plays were and move independently", () => {
    const l = fake(range(0, 3.3));
    const r = fake(range(0, 2.8));
    const a = align(l, r, "progress");
    const master = masterClock(a);
    master.seek(1.65);
    const locals = unsync(master, a, l, r);
    expect(locals.left.getTime()).toBeCloseTo(l.times[progressIndex(34, 0.5)]);
    expect(locals.right.getTime()).toBeCloseTo(r.times[progressIndex(29, 0.5)]);
    const rightBefore = locals.right.getTime();
    locals.left.seek(3.0);
    expect(locals.right.getTime()).toBe(rightBefore);
    expect(master.getTime()).toBeCloseTo(1.65);
    // Sync again from the left play's position.
    resync(master, a, locals);
    expect(a.toLeft(master.getTime())).toBeCloseTo(3.0, 1);
    master.dispose();
  });
});
