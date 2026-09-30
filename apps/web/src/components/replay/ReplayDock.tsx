"use client";

import { AlertTriangle, ChevronLeft, ChevronRight, Pause, Play, SkipForward } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip } from "@/components/ui/Tooltip";
import { elapsed } from "@/lib/format";
import { SPEEDS, useClockState, useTimeDerived, type Clock } from "@/lib/replay/clock";
import { handleReplayKey } from "@/lib/replay/keys";
import { frameIndexAt } from "@/lib/tracking/series";
import { Timeline, type TimelineLane, type TimelineMarker } from "./Timeline";

export interface TimeOrigin {
  time: number;
  kind: "snap" | "recording";
}

export function originLabel(o: TimeOrigin) {
  return o.kind === "snap" ? "from snap" : "From recording start";
}

/**
 * 96 px replay dock attached below the stage: a 40 px control row and a
 * 56 px timeline region (§7).
 */
export function ReplayDock({
  clock,
  times,
  frameIds,
  origin,
  lanes,
  markers,
  span,
  flash,
  disabledReason,
  onUserSeek,
  trailing,
}: {
  clock: Clock;
  times: number[];
  frameIds: number[];
  origin: TimeOrigin;
  lanes: TimelineLane[];
  markers?: TimelineMarker[];
  span?: { from: number; to: number; label: string } | null;
  flash?: { time: number; id: number } | null;
  disabledReason?: string | null;
  onUserSeek?: () => void;
  trailing?: ReactNode;
}) {
  const { playing, speed, pendingGap } = useClockState(clock);
  const idx = useTimeDerived(clock, (t) => frameIndexAt(times, t));
  const disabled = !!disabledReason;
  const valueText = (t: number) => {
    const i = frameIndexAt(times, t);
    return `Frame ${frameIds[i]}, ${elapsed(times[i] - origin.time)} ${origin.kind === "snap" ? "from snap" : "from recording start"}`;
  };

  return (
    <div className="h-24 border-t border-border bg-bg">
      <div className="flex h-10 items-center gap-1">
        <Tooltip content={playing ? "Pause (Space)" : "Play (Space)"} describe={false}>
          <button
            type="button"
            className="btn btn-lg btn-icon"
            aria-label={playing ? "Pause" : "Play"}
            onClick={() => clock.toggle()}
            disabled={disabled}
          >
            {playing ? <Pause size={20} strokeWidth={1.5} aria-hidden /> : <Play size={20} strokeWidth={1.5} aria-hidden />}
          </button>
        </Tooltip>
        <Tooltip content="Previous frame (←)" describe={false}>
          <button
            type="button"
            className="btn btn-quiet btn-icon"
            aria-label="Previous frame"
            disabled={disabled || idx === 0}
            onClick={() => {
              clock.step(-1);
              onUserSeek?.();
            }}
          >
            <ChevronLeft size={16} strokeWidth={1.5} aria-hidden />
          </button>
        </Tooltip>
        <Tooltip content="Next frame (→)" describe={false}>
          <button
            type="button"
            className="btn btn-quiet btn-icon"
            aria-label="Next frame"
            disabled={disabled || idx === times.length - 1}
            onClick={() => {
              clock.step(1);
              onUserSeek?.();
            }}
          >
            <ChevronRight size={16} strokeWidth={1.5} aria-hidden />
          </button>
        </Tooltip>
        <div role="radiogroup" aria-label="Playback speed" className="segmented ml-2 hidden md:inline-flex">
          {SPEEDS.map((s) => (
            <button
              key={s}
              type="button"
              role="radio"
              aria-checked={speed === s}
              className="num"
              disabled={disabled}
              onClick={() => clock.setSpeed(s)}
            >
              {s}×
            </button>
          ))}
        </div>
        <p className="num ml-3 text-meta text-fg" aria-hidden>
          {elapsed(times[idx] - origin.time)}
          <span className="ml-1.5 font-sans text-caption text-muted">{originLabel(origin)}</span>
        </p>
        <p className="num ml-3 hidden text-meta text-fg-2 md:block" aria-hidden>
          Frame {frameIds[idx]}
        </p>
        <div className="ml-auto flex items-center gap-2">
          {pendingGap && (
            <>
              <span className="hidden items-center gap-1.5 text-caption text-fg-2 lg:inline-flex">
                <AlertTriangle size={14} strokeWidth={1.5} aria-hidden className="text-warning" />
                Tracking gap ahead · frames {frameIds[idx] + 1}–{frameIds[Math.min(idx + 1, frameIds.length - 1)] - 1} missing
              </span>
              <button type="button" className="btn btn-sm" onClick={() => clock.skipGap()}>
                <SkipForward size={14} strokeWidth={1.5} aria-hidden />
                Skip gap
              </button>
            </>
          )}
          {disabledReason && <span className="text-caption text-muted">{disabledReason}</span>}
          {trailing}
        </div>
      </div>
      <Timeline
        domain={[times[0], times[times.length - 1]]}
        lanes={lanes}
        source={clock}
        markers={markers}
        span={span}
        flash={flash}
        disabledReason={disabledReason}
        label="Replay position"
        valueText={valueText}
        onSeek={(t) => {
          clock.seek(t);
          onUserSeek?.();
        }}
        onKey={(e) => handleReplayKey(e, clock, { canPlay: !disabled, onSeek: onUserSeek })}
      />
    </div>
  );
}
