"use client";

import type { ReactNode } from "react";
import { elapsed } from "@/lib/format";
import { useTimeDerived, type TimeSource } from "@/lib/replay/clock";
import type { Orientation } from "@/lib/tracking/geometry";
import { frameIndexAt, type TrackingSeries } from "@/lib/tracking/series";

/** Stage sizing (§4): preferred 16:9, ≤ 640 px, shrinks to keep the dock visible, ≥ 300 px on short windows. */
export const STAGE_HEIGHT = "clamp(min(300px, 56.25cqi), min(56.25cqi, 100dvh - var(--stage-chrome) - 8px), 640px)";

export function OrientationLabel({ series, orientation }: { series: TrackingSeries | null; orientation: Orientation }) {
  if (!series) return null;
  const known = series.direction !== null;
  return (
    <div className="pointer-events-none absolute top-2 left-2 z-10 flex items-center gap-2 text-caption">
      {orientation === "normalized" && known ? (
        <>
          <span className="bg-field px-1.5 py-0.5 font-medium text-fg">Attack →</span>
          <span className="bg-field px-1.5 py-0.5 text-field-label">Direction normalized</span>
        </>
      ) : (
        <span className="bg-field px-1.5 py-0.5 text-field-label">
          {known ? `Source view · offense attacks ${series.direction === "right" ? "→" : "←"}` : "Source view · play direction unknown"}
        </span>
      )}
    </div>
  );
}

export function FrameLabel({ series, time, origin }: { series: TrackingSeries; time: TimeSource; origin: number | null }) {
  const i = useTimeDerived(time, (t) => frameIndexAt(series.times, t));
  const o = origin ?? series.times[0];
  return (
    <div className="num pointer-events-none absolute bottom-2 left-2 z-10 bg-field px-1.5 py-0.5 text-meta text-field-label" aria-hidden>
      Frame {series.frameIds[i]} · {elapsed(series.times[i] - o)}
      {origin === null && <span className="font-sans text-caption"> from start</span>}
    </div>
  );
}

export function StageNote({ children }: { children: ReactNode }) {
  return (
    <div className="pointer-events-none absolute top-2 right-2 z-10 max-w-[60%] bg-field px-1.5 py-0.5 text-right text-caption text-field-label">
      {children}
    </div>
  );
}

export function StageLegend({ children }: { children: ReactNode }) {
  return <div className="absolute right-2 bottom-2 z-10 max-w-[70%] bg-field px-2 py-1">{children}</div>;
}

export function StagePlaceholder({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-surface text-caption text-muted" role="status">
      {children}
    </div>
  );
}
