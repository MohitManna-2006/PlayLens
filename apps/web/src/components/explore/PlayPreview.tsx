"use client";

import { Pause, Play, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FieldViewport } from "@/components/field/FieldViewport";
import { StatusState } from "@/components/ui/StatusState";
import { errorMessage } from "@/lib/datasource";
import { codeLabel, downDistance, elapsed, matchup, quarterClock } from "@/lib/format";
import { usePlayData } from "@/lib/hooks/usePlayData";
import { Clock, useClockState, useTimeDerived } from "@/lib/replay/clock";
import { actionExtent, frameIndexAt } from "@/lib/tracking/series";

/**
 * Static snap-frame preview (§6). Never autoplays; the user may explicitly
 * start a replay of the preview.
 */
export function PlayPreview({
  playId,
  onClose,
  compareHref,
  variant,
}: {
  playId: string;
  onClose: () => void;
  compareHref: string;
  variant: "pane" | "inline";
}) {
  const { detail, frames, series, seriesError } = usePlayData(playId);
  const clock = useMemo(() => {
    if (!series) return null;
    const t = series.times;
    return new Clock({ start: t[0], end: t[t.length - 1], stops: t, initial: series.snapIndex !== null ? t[series.snapIndex] : t[0] });
  }, [series]);
  useEffect(() => () => clock?.dispose(), [clock]);
  const extent = useMemo(() => (series ? actionExtent(series, "normalized") : null), [series]);
  const d = detail.data;
  const error = detail.error ?? frames.error;

  return (
    <section
      aria-label={`Preview of play ${playId}`}
      className={variant === "pane" ? "sticky top-[calc(var(--nav-h)+16px)] border-l border-border pl-6" : "bg-surface px-4 py-4"}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-panel font-semibold">{d ? matchup(d) : "Preview"}</h2>
          <p className="num mt-0.5 text-meta text-fg-2">
            {d ? [quarterClock(d), downDistance(d), d.yardline_label, d.id].filter(Boolean).join("   ") : playId}
          </p>
        </div>
        <button type="button" className="btn btn-quiet btn-icon" aria-label="Close preview" onClick={onClose}>
          <X size={16} strokeWidth={1.5} aria-hidden />
        </button>
      </div>
      {d && <p className="mt-2 text-body-2 text-fg-2">{d.description ?? <span className="text-muted">No supplied description</span>}</p>}
      {d && (
        <p className="mt-1 text-caption text-muted">
          {[
            codeLabel(d.context.offense_formation),
            codeLabel(d.annotations.coverage_type),
            `${d.tracking.observed_frame_count} frames · ${d.tracking.player_count} tracked players`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}

      <div className="mt-3 aspect-video w-full">
        {error || seriesError ? (
          <StatusState kind="error" title="Preview unavailable">
            {seriesError ?? errorMessage(error)}
          </StatusState>
        ) : series && clock && extent ? (
          <FieldViewport
            series={series}
            time={clock}
            extent={extent}
            orientation="normalized"
            label={`Play ${playId} at the snap`}
            className="h-full w-full"
          />
        ) : (
          <div className="skeleton flex h-full w-full items-center justify-center text-caption text-muted">Loading tracking frames</div>
        )}
      </div>
      {series && clock && <PreviewControls clock={clock} snap={series.snapIndex !== null ? series.times[series.snapIndex] : null} times={series.times} frameIds={series.frameIds} />}

      <div className="mt-4 flex flex-wrap gap-2">
        <Link href={`/play/${encodeURIComponent(playId)}`} className="btn btn-primary">
          Open play
        </Link>
        <Link href={compareHref} className="btn">
          Compare
        </Link>
      </div>
    </section>
  );
}

function PreviewControls({ clock, snap, times, frameIds }: { clock: Clock; snap: number | null; times: number[]; frameIds: number[] }) {
  const { playing } = useClockState(clock);
  const idx = useTimeDerived(clock, (t) => frameIndexAt(times, t));
  const [started, setStarted] = useState(false);
  const origin = snap ?? times[0];
  return (
    <div className="mt-2 flex items-center justify-between gap-3">
      <p className="num text-meta text-fg-2">
        {started ? `${elapsed(times[idx] - origin)} · Frame ${frameIds[idx]}` : snap !== null ? `Snap · Frame ${frameIds[idx]}` : `Recording start · Frame ${frameIds[idx]}`}
      </p>
      <button
        type="button"
        className="btn btn-quiet btn-sm"
        onClick={() => {
          setStarted(true);
          if (!playing && idx === times.length - 1) clock.seek(times[0]);
          clock.toggle();
        }}
      >
        {playing ? <Pause size={14} strokeWidth={1.5} aria-hidden /> : <Play size={14} strokeWidth={1.5} aria-hidden />}
        {playing ? "Pause preview" : "Play preview"}
      </button>
    </div>
  );
}
