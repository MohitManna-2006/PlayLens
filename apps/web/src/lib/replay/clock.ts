/**
 * Replay clock. Time advances from real timestamps (§14: replay follows
 * timestamps, independent of interface easing). Seeks resolve to real frames
 * and pause. Playback stops at the last frame and pauses before crossing a
 * missing tracking interval so the user can choose to skip it.
 *
 * The clock is an external store: canvases and the playhead subscribe to
 * ticks without re-rendering React; components read discrete state
 * (playing, speed, pending gap) through useClockState.
 */
import { useSyncExternalStore } from "react";

export interface TimeSource {
  getTime(): number;
  subscribe(listener: () => void): () => void;
}

export interface ClockGap {
  from: number;
  to: number;
}

export interface ClockOptions {
  start: number;
  end: number;
  /** Real sample times that seeks and steps resolve to. */
  stops: number[];
  gaps?: ClockGap[];
  initial?: number;
}

export interface ClockState {
  playing: boolean;
  speed: number;
  pendingGap: ClockGap | null;
  atEnd: boolean;
  version: number;
}

export const SPEEDS = [0.25, 0.5, 1, 2] as const;

export class Clock implements TimeSource {
  private t: number;
  private opts: ClockOptions;
  private raf: number | null = null;
  private last = 0;
  private tickListeners = new Set<() => void>();
  private stateListeners = new Set<() => void>();
  private state: ClockState;

  constructor(opts: ClockOptions) {
    this.opts = opts;
    this.t = opts.initial ?? opts.start;
    this.state = { playing: false, speed: 1, pendingGap: null, atEnd: this.t >= opts.end, version: 0 };
  }

  get start() {
    return this.opts.start;
  }
  get end() {
    return this.opts.end;
  }
  get stops() {
    return this.opts.stops;
  }

  getTime = () => this.t;
  getState = () => this.state;

  subscribe = (listener: () => void) => {
    this.tickListeners.add(listener);
    return () => this.tickListeners.delete(listener);
  };

  subscribeState = (listener: () => void) => {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  };

  private emitTick() {
    this.tickListeners.forEach((l) => l());
  }

  private setState(patch: Partial<ClockState>) {
    this.state = { ...this.state, ...patch, version: this.state.version + 1 };
    this.stateListeners.forEach((l) => l());
  }

  private nearestStop(t: number): number {
    const s = this.opts.stops;
    if (!s.length) return Math.min(this.end, Math.max(this.start, t));
    let best = s[0];
    for (const v of s) if (Math.abs(v - t) < Math.abs(best - t)) best = v;
    return best;
  }

  private stopIndex(t: number): number {
    const s = this.opts.stops;
    let idx = 0;
    for (let i = 0; i < s.length; i++) if (s[i] <= t + 1e-6) idx = i;
    return idx;
  }

  /** Seek to the nearest real frame and pause (§7 replay dock). */
  seek(t: number, { keepPlaying = false } = {}) {
    this.t = this.nearestStop(t);
    if (!keepPlaying) this.pause();
    this.setState({ pendingGap: null, atEnd: this.t >= this.end - 1e-6 });
    this.emitTick();
  }

  seekExact(t: number) {
    this.t = Math.min(this.end, Math.max(this.start, t));
    this.pause();
    this.setState({ pendingGap: null, atEnd: this.t >= this.end - 1e-6 });
    this.emitTick();
  }

  step(delta: number) {
    const s = this.opts.stops;
    if (!s.length) return;
    const i = Math.min(s.length - 1, Math.max(0, this.stopIndex(this.t) + delta));
    this.seek(s[i]);
  }

  stepSeconds(delta: number) {
    this.seek(Math.min(this.end, Math.max(this.start, this.t + delta)));
  }

  toStart() {
    this.seek(this.start);
  }

  toEnd() {
    this.seek(this.end);
  }

  setSpeed(speed: number) {
    this.setState({ speed });
  }

  play() {
    if (this.state.playing) return;
    if (this.t >= this.end - 1e-6) this.t = this.start;
    this.setState({ playing: true, pendingGap: null, atEnd: false });
    this.last = performance.now();
    this.loop();
  }

  pause() {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    if (this.state.playing) this.setState({ playing: false });
  }

  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  skipGap() {
    const gap = this.state.pendingGap;
    if (!gap) return;
    this.t = gap.to;
    this.setState({ pendingGap: null });
    this.emitTick();
    this.play();
  }

  /** Replace the time domain (e.g. Compare alignment change) keeping t in range. */
  reconfigure(opts: ClockOptions) {
    this.opts = opts;
    this.t = Math.min(opts.end, Math.max(opts.start, opts.initial ?? this.t));
    this.pause();
    this.setState({ pendingGap: null, atEnd: this.t >= opts.end - 1e-6 });
    this.emitTick();
  }

  dispose() {
    this.pause();
    this.tickListeners.clear();
    this.stateListeners.clear();
  }

  private loop = () => {
    this.raf = requestAnimationFrame((now) => {
      const dt = Math.min(0.1, (now - this.last) / 1000);
      this.last = now;
      let next = this.t + dt * this.state.speed;
      const gap = this.opts.gaps?.find((g) => this.t < g.from + 1e-6 && next > g.from + 1e-6);
      if (gap) {
        this.t = gap.from;
        this.raf = null;
        this.setState({ playing: false, pendingGap: gap });
        this.emitTick();
        return;
      }
      if (next >= this.end) {
        next = this.end;
        this.t = next;
        this.raf = null;
        this.setState({ playing: false, atEnd: true });
        this.emitTick();
        return;
      }
      this.t = next;
      this.emitTick();
      this.loop();
    });
  };
}

export function useClockState(clock: Clock): ClockState {
  return useSyncExternalStore(clock.subscribeState, clock.getState, clock.getState);
}

/** Re-renders only when the derived value changes (e.g. the current frame index). */
export function useTimeDerived<T extends string | number | boolean | null>(source: TimeSource, derive: (t: number) => T): T {
  return useSyncExternalStore(
    source.subscribe,
    () => derive(source.getTime()),
    () => derive(source.getTime()),
  );
}

/** A time source that maps another source's time through a function (Compare lanes). */
export function mappedSource(base: TimeSource, map: (t: number) => number): TimeSource {
  return { getTime: () => map(base.getTime()), subscribe: base.subscribe };
}
