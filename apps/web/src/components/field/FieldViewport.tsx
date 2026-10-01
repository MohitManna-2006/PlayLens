"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { playerLabel, sideLabel, speed as fmtSpeed } from "@/lib/format";
import type { TimeSource } from "@/lib/replay/clock";
import { fitViewport, isFlipped, type Extent, type Orientation, type Viewport } from "@/lib/tracking/geometry";
import { frameIndexAt, gapAfter, isPresent, type TrackingSeries } from "@/lib/tracking/series";
import {
  DEFAULT_OVERLAYS,
  playerScreenPosition,
  render,
  type ForecastLayer,
  type GroundTruthLayer,
  type OverlayState,
  type PlayLabLayer,
  type RenderInput,
} from "./renderer";

export interface FieldApi {
  vp: Viewport;
  flipped: boolean;
  width: number;
  height: number;
}

interface Props {
  series: TrackingSeries | null;
  time: TimeSource;
  extent: Extent;
  orientation: Orientation;
  overlays?: OverlayState;
  selectedId?: string | null;
  counterpartId?: string | null;
  forecast?: ForecastLayer | null;
  playlab?: PlayLabLayer | null;
  groundTruth?: GroundTruthLayer | null;
  /** Hold the final frame and label it (Compare after one play ends). */
  ended?: boolean;
  interpolate?: boolean;
  onSelect?: (playerId: string) => void;
  /** Restrict hover and selection hits (PlayLab eligible defenders). */
  hitFilter?: (trackIndex: number) => boolean;
  label: string;
  className?: string;
  children?: (api: FieldApi) => ReactNode;
}

function readFonts() {
  const cs = getComputedStyle(document.documentElement);
  const mono = cs.getPropertyValue("--font-geist-mono").trim() || "ui-monospace, monospace";
  const sans = cs.getPropertyValue("--font-geist-sans").trim() || "system-ui, sans-serif";
  return { mono: `${mono}, ui-monospace, monospace`, sans: `${sans}, system-ui, sans-serif` };
}

/**
 * Field stage: isotropic canvas rendering plus an HTML layer for anchored
 * tooltips and interaction controls. Redraws on time ticks without React
 * re-rendering; hover tooltips appear after 150 ms (§7).
 */
export function FieldViewport({
  series,
  time,
  extent,
  orientation,
  overlays = DEFAULT_OVERLAYS,
  selectedId = null,
  counterpartId = null,
  forecast = null,
  playlab = null,
  groundTruth = null,
  ended = false,
  interpolate = true,
  onSelect,
  hitFilter,
  label,
  className = "",
  children,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0, dpr: 1 });
  const [fonts, setFonts] = useState(() =>
    typeof document === "undefined" ? { mono: "ui-monospace, monospace", sans: "system-ui, sans-serif" } : readFonts(),
  );
  const [hovered, setHovered] = useState<number | null>(null);
  const [tooltipFor, setTooltipFor] = useState<number | null>(null);
  const hoverTimer = useRef<number | null>(null);
  const raf = useRef<number | null>(null);

  const flipped = isFlipped(series?.direction ?? null, orientation);
  const vp = useMemo(() => fitViewport(extent, size.w, size.h), [extent, size.w, size.h]);

  const indexOf = useCallback(
    (id: string | null) => (id && series ? series.tracks.findIndex((t) => t.ref.player_id === id) : -1),
    [series],
  );
  const selected = indexOf(selectedId);
  const counterpart = indexOf(counterpartId);

  const latest: Omit<RenderInput, "frameIndex" | "alpha"> = {
    width: size.w,
    height: size.h,
    dpr: size.dpr,
    vp,
    flipped,
    series,
    selected: selected >= 0 ? selected : null,
    hovered,
    counterpart: counterpart >= 0 ? counterpart : null,
    overlays,
    forecast,
    playlab,
    groundTruth,
    fonts,
    ended,
  };
  const inputRef = useRef(latest);

  const frameAt = useCallback(
    (t: number) => {
      if (!series || !series.times.length) return { frameIndex: 0, alpha: 0 };
      const i = frameIndexAt(series.times, t);
      let alpha = 0;
      if (interpolate && i + 1 < series.times.length && !gapAfter(series, i)) {
        const span = series.times[i + 1] - series.times[i];
        alpha = span > 0 ? Math.min(1, Math.max(0, (t - series.times[i]) / span)) : 0;
        if (alpha < 1e-3) alpha = 0;
      }
      return { frameIndex: i, alpha };
    },
    [series, interpolate],
  );
  const frameAtRef = useRef(frameAt);
  const tooltipForRef = useRef(tooltipFor);
  useLayoutEffect(() => {
    inputRef.current = latest;
    frameAtRef.current = frameAt;
    tooltipForRef.current = tooltipFor;
  });

  const draw = useCallback(() => {
    raf.current = null;
    const c = canvas.current;
    const base = inputRef.current;
    if (!c || base.width === 0) return;
    const ctx = c.getContext("2d");
    if (!ctx) return;
    const { frameIndex, alpha } = frameAtRef.current(time.getTime());
    const input: RenderInput = { ...base, frameIndex, alpha };
    render(ctx, input);
    const tip = tooltip.current;
    const tj = tooltipForRef.current;
    if (tip && tj !== null) {
      const p = playerScreenPosition(input, tj);
      if (p) {
        const w = tip.offsetWidth;
        const h = tip.offsetHeight;
        const x = Math.min(base.width - w - 4, Math.max(4, p.x - w / 2));
        const y = p.y - h - 18 < 4 ? p.y + 18 : p.y - h - 18;
        tip.style.transform = `translate(${x}px, ${y}px)`;
        tip.style.visibility = "visible";
      } else {
        tip.style.visibility = "hidden";
      }
    }
  }, [time]);

  const schedule = useCallback(() => {
    if (raf.current === null) raf.current = requestAnimationFrame(draw);
  }, [draw]);

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      setSize({ w: Math.round(width), h: Math.round(height), dpr: window.devicePixelRatio || 1 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    document.fonts?.ready.then(() => {
      if (!cancelled) setFonts(readFonts());
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const c = canvas.current;
    if (!c) return;
    c.width = Math.max(1, Math.round(size.w * size.dpr));
    c.height = Math.max(1, Math.round(size.h * size.dpr));
    draw();
  }, [size, draw]);

  useEffect(() => {
    schedule();
  });

  useEffect(() => time.subscribe(schedule), [time, schedule]);
  useEffect(
    () => () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
      if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    },
    [],
  );

  const hitTest = (clientX: number, clientY: number): number | null => {
    const rect = container.current?.getBoundingClientRect();
    if (!rect || !series) return null;
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const { frameIndex, alpha } = frameAt(time.getTime());
    const input = { ...latest, frameIndex, alpha };
    let best: number | null = null;
    let bestD = 12;
    series.tracks.forEach((_, j) => {
      if (hitFilter && !hitFilter(j)) return;
      const p = playerScreenPosition(input, j);
      if (!p) return;
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    });
    return best;
  };

  const setHover = (j: number | null) => {
    if (j === hovered) return;
    setHovered(j);
    if (hoverTimer.current) window.clearTimeout(hoverTimer.current);
    setTooltipFor(null);
    if (j !== null) hoverTimer.current = window.setTimeout(() => setTooltipFor(j), 150);
  };

  const { frameIndex } = frameAt(time.getTime());
  const tipTrack = tooltipFor !== null && series ? series.tracks[tooltipFor] : null;
  const tipSpeed = tipTrack && isPresent(tipTrack, frameIndex) ? tipTrack.s[frameIndex] : NaN;

  return (
    <div
      ref={container}
      className={`relative overflow-hidden bg-surface ${className}`}
      onPointerMove={(e) => {
        if (e.pointerType !== "mouse") return;
        setHover(hitTest(e.clientX, e.clientY));
      }}
      onPointerLeave={() => setHover(null)}
      onClick={(e) => {
        if (!onSelect) return;
        const j = hitTest(e.clientX, e.clientY);
        if (j !== null && series) onSelect(series.tracks[j].ref.player_id);
      }}
      style={{ cursor: hovered !== null && onSelect ? "pointer" : "default" }}
    >
      <canvas ref={canvas} role="img" aria-label={label} className="absolute inset-0 h-full w-full" />
      {tipTrack && (
        <div
          ref={tooltip}
          aria-hidden
          className="float-surface pointer-events-none absolute top-0 left-0 z-10 px-2 py-1.5"
          style={{ visibility: "hidden" }}
        >
          <p className="text-body-2 font-medium text-fg">{playerLabel(tipTrack.ref)}{tipTrack.ref.name ? "" : " · name unavailable"}</p>
          <p className="text-caption text-fg-2">
            {sideLabel(tipTrack.ref.side)} · {tipTrack.ref.position ?? "Role unavailable"}
            {tipTrack.ref.role ? ` · ${tipTrack.ref.role}` : ""}
          </p>
          <p className="num text-meta text-fg">{Number.isFinite(tipSpeed) ? fmtSpeed(tipSpeed) : "Speed unavailable"}</p>
        </div>
      )}
      {size.w > 0 && children?.({ vp, flipped, width: size.w, height: size.h })}
    </div>
  );
}
