"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { fixed } from "@/lib/format";
import { useTimeDerived, type TimeSource } from "@/lib/replay/clock";
import { isFlipped, toDisplay, type Orientation } from "@/lib/tracking/geometry";
import { nearestOpponent } from "@/lib/tracking/measures";
import { frameIndexAt, isPresent, type TrackingSeries } from "@/lib/tracking/series";

/**
 * Accessible counterpart of the canvas (§18): every player at the current
 * frame, with selection linked to the field and inspector.
 */
export function FrameDataTable({
  series,
  time,
  orientation,
  selectedId,
  onSelect,
  title = "Frame data table",
  defaultOpen = false,
}: {
  series: TrackingSeries;
  time: TimeSource;
  orientation: Orientation;
  selectedId: string | null;
  onSelect: (id: string) => void;
  title?: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const i = useTimeDerived(time, (t) => frameIndexAt(series.times, t));
  const flipped = isFlipped(series.direction, orientation);
  return (
    <section className="mt-8">
      <button
        type="button"
        className="flex items-center gap-1.5 text-panel font-semibold"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? <ChevronDown size={16} strokeWidth={1.5} aria-hidden /> : <ChevronRight size={16} strokeWidth={1.5} aria-hidden />}
        {title}
        <span className="num ml-2 text-meta font-normal text-fg-2">Frame {series.frameIds[i]}</span>
      </button>
      <p className="mt-1 text-caption text-muted">
        Every tracked player at the current frame. Positions in {orientation === "normalized" ? "direction-normalized" : "source"} yards. Selecting a row selects the player on the field.
      </p>
      {open && (
        <div className="scroll-quiet mt-3 overflow-x-auto" role="region" aria-label={`${title}, frame ${series.frameIds[i]}`} tabIndex={0}>
          <table className="data-table min-w-[720px]">
            <thead>
              <tr>
                <th scope="col">Player</th>
                <th scope="col">Side</th>
                <th scope="col">Role</th>
                <th scope="col" className="n">x (yd)</th>
                <th scope="col" className="n">y (yd)</th>
                <th scope="col" className="n">Speed (yd/s)</th>
                <th scope="col" className="n">Accel. (yd/s²)</th>
                <th scope="col" className="n">Nearest opp. (yd)</th>
                <th scope="col"><span className="sr-only">Select</span></th>
              </tr>
            </thead>
            <tbody>
              {series.tracks.map((t, j) => {
                const present = isPresent(t, i);
                const p = present ? toDisplay(t.x[i], t.y[i], flipped) : null;
                const n = present ? nearestOpponent(series, j, i) : null;
                const sel = selectedId === t.ref.player_id;
                return (
                  <tr key={t.ref.player_id} className={sel ? "bg-selected" : undefined}>
                    <td className="num text-fg">{t.ref.jersey ? `#${t.ref.jersey}` : (t.ref.name ?? t.ref.player_id)}</td>
                    <td>{t.ref.side === "offense" ? "Offense" : "Defense"}</td>
                    <td>{t.ref.position ?? "Unavailable"}</td>
                    {present ? (
                      <>
                        <td className="n">{fixed(p!.x, 1)}</td>
                        <td className="n">{fixed(p!.y, 1)}</td>
                        <td className="n">{fixed(t.s[i], 1)}</td>
                        <td className="n">{fixed(t.a[i], 1)}</td>
                        <td className="n">{fixed(n?.distance, 1)}</td>
                      </>
                    ) : (
                      <td colSpan={5} className="text-muted">
                        Not tracked at this frame
                      </td>
                    )}
                    <td className="text-right">
                      <button type="button" className="btn btn-quiet btn-sm" aria-pressed={sel} onClick={() => onSelect(t.ref.player_id)}>
                        {sel ? "Selected" : "Select"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
