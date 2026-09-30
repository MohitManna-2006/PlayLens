"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { TimeSource } from "@/lib/replay/clock";
import { useTimeDerived } from "@/lib/replay/clock";
import type { EventKind } from "@/lib/tracking/series";

export interface TimelineEvent {
  key: string;
  time: number;
  label: string;
  kind: EventKind;
  description: string;
}

export interface TimelineLane {
  id: string;
  label?: string;
  events: TimelineEvent[];
  gaps: Array<{ from: number; to: number }>;
  /** Observed extent of this lane inside the shared domain. */
  observed: [number, number];
}

export interface TimelineMarker {
  key: string;
  time: number;
  label: string;
  kind: "origin" | "editable";
  description: string;
}

interface Props {
  domain: [number, number];
  lanes: TimelineLane[];
  source: TimeSource;
  onSeek: (t: number) => void;
  onKey: (e: KeyboardEvent<HTMLDivElement>) => void;
  valueText: (t: number) => string;
  markers?: TimelineMarker[];
  span?: { from: number; to: number; label: string } | null;
  disabledReason?: string | null;
  flash?: { time: number; id: number } | null;
  label: string;
}

const LABEL_W = (s: string) => s.length * 6.6 + 14;

function Shape({ kind, size = 10 }: { kind: EventKind | "origin" | "editable"; size?: number }) {
  const h = size / 2;
  switch (kind) {
    case "snap":
      return <rect x={-h + 1} y={-h + 1} width={size - 2} height={size - 2} fill="#F2F4F5" stroke="#101214" strokeWidth={1} />;
    case "throw":
      return <path d={`M0 ${-h} L${h} ${h - 1} L${-h} ${h - 1} Z`} fill="#F2F4F5" stroke="#101214" strokeWidth={1} />;
    case "arrival":
    case "catch":
      return <circle r={h - 0.5} fill="#F2F4F5" stroke="#101214" strokeWidth={1} />;
    case "origin":
      return <path d={`M0 ${-h} L${h} 0 L0 ${h} L${-h} 0 Z`} fill="#101214" stroke="#E7B66B" strokeWidth={1.5} />;
    case "editable":
      return <rect x={-h + 1} y={-h + 1} width={size - 2} height={size - 2} fill="#101214" stroke="#E7B66B" strokeWidth={1.5} />;
    default:
      return <rect x={-0.75} y={-h} width={1.5} height={size} fill="#B7C0C8" />;
  }
}

/**
 * Replay timeline (§7): observed-duration rail, event markers with distinct
 * shapes plus text in two label lanes, hatched gaps, a 2 px amber playhead,
 * and a labeled slider whose seek target is 32 px tall.
 */
export function Timeline({ domain, lanes, source, onSeek, onKey, valueText, markers = [], span, disabledReason, flash, label }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const playhead = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const dragging = useRef(false);
  const [t0, t1] = domain;
  const x = (t: number) => ((t - t0) / Math.max(1e-6, t1 - t0)) * width;
  const multi = lanes.length > 1;
  const gutter = multi ? 48 : 0;
  const laneH = 56 / lanes.length;

  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.max(0, e.contentRect.width - (multi ? 48 : 0))));
    ro.observe(el);
    return () => ro.disconnect();
  }, [multi]);

  useEffect(() => {
    const update = () => {
      const el = playhead.current;
      if (!el || width === 0) return;
      const px = ((source.getTime() - t0) / Math.max(1e-6, t1 - t0)) * width;
      el.style.transform = `translateX(${Math.round(px) - 1}px)`;
    };
    update();
    return source.subscribe(update);
  }, [source, t0, t1, width]);

  const text = useTimeDerived(source, valueText);
  const now = useTimeDerived(source, (t) => Math.round(t * 10) / 10);

  const laid = useMemo(
    () =>
      lanes.map((lane) => {
        const lanesEnd = multi ? [-Infinity] : [-Infinity, -Infinity];
        return lane.events
          .slice()
          .sort((a, b) => a.time - b.time)
          .map((e) => {
            const px = ((e.time - t0) / Math.max(1e-6, t1 - t0)) * width;
            const w = LABEL_W(e.label);
            const slot = lanesEnd.findIndex((end) => px - 4 >= end);
            if (slot >= 0) lanesEnd[slot] = px - 4 + w;
            return { e, px, slot };
          });
      }),
    [lanes, t0, t1, width, multi],
  );

  const seekFromPointer = (clientX: number) => {
    const rect = root.current?.getBoundingClientRect();
    if (!rect || width === 0) return;
    const f = Math.min(1, Math.max(0, (clientX - rect.left - gutter) / width));
    onSeek(t0 + f * (t1 - t0));
  };

  const disabled = !!disabledReason;

  return (
    <div ref={root} className="relative h-14 select-none" style={{ paddingLeft: gutter }}>
      {lanes.map((lane, li) => {
        const top = li * laneH;
        const railY = top + laneH - (multi ? 10 : 12);
        return (
          <div key={lane.id}>
            {multi && lane.label && (
              <span className="absolute left-0 text-caption text-muted" style={{ top: railY - 8 }}>
                {lane.label}
              </span>
            )}
            <div
              aria-hidden
              className="absolute h-1 bg-border"
              style={{ left: gutter + x(lane.observed[0]), width: Math.max(0, x(lane.observed[1]) - x(lane.observed[0])), top: railY }}
            />
            {lane.gaps.map((g) => (
              <div
                key={g.from}
                aria-hidden
                className="hatch absolute h-3 border-x border-control bg-surface"
                style={{ left: gutter + x(g.from), width: Math.max(3, x(g.to) - x(g.from)), top: railY - 4 }}
              />
            ))}
            {laid[li].map(({ e, px, slot }) => (
              <div key={e.key}>
                {slot >= 0 && (
                  <span
                    aria-hidden
                    className="pointer-events-none absolute text-caption whitespace-nowrap text-fg-2"
                    style={{ left: gutter + px - 4, top: multi ? top : slot * 14 + 2, lineHeight: "14px" }}
                  >
                    {e.label}
                  </span>
                )}
                <button
                  type="button"
                  className="absolute z-20 flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-[2px] focus-visible:outline-offset-1"
                  style={{ left: gutter + px, top: railY - 6 }}
                  aria-label={e.description}
                  title={e.description}
                  disabled={disabled}
                  onClick={() => onSeek(e.time)}
                >
                  <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden>
                    <Shape kind={e.kind} />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        );
      })}

      {span && width > 0 && (
        <div
          aria-hidden
          title={span.label}
          className="absolute h-0.5 bg-accent"
          style={{ left: gutter + x(span.from), width: Math.max(2, x(span.to) - x(span.from)), bottom: 2 }}
        />
      )}
      {markers.map((m) => (
        <div key={m.key}>
          <span
            aria-hidden
            className="pointer-events-none absolute text-caption whitespace-nowrap text-accent"
            style={{ left: gutter + x(m.time) + 8, bottom: 14, lineHeight: "14px" }}
          >
            {m.label}
          </span>
          <button
            type="button"
            className="absolute z-20 flex h-4 w-4 -translate-x-1/2 items-center justify-center"
            style={{ left: gutter + x(m.time), bottom: 12 }}
            aria-label={m.description}
            title={m.description}
            disabled={disabled}
            onClick={() => onSeek(m.time)}
          >
            <svg width="12" height="12" viewBox="-6 -6 12 12" aria-hidden>
              <Shape kind={m.kind} />
            </svg>
          </button>
        </div>
      ))}

      {flash && width > 0 && (
        <div
          key={flash.id}
          aria-hidden
          className="pointer-events-none absolute z-30 h-5 w-5 -translate-x-1/2 rounded-full outline-2 outline-transparent motion-safe:animate-[marker-flash_400ms_linear]"
          style={{ left: gutter + x(flash.time), bottom: 8 }}
        />
      )}

      <div
        role="slider"
        tabIndex={disabled ? -1 : 0}
        aria-label={label}
        aria-valuemin={Math.round(t0 * 10) / 10}
        aria-valuemax={Math.round(t1 * 10) / 10}
        aria-valuenow={now}
        aria-valuetext={text}
        aria-disabled={disabled || undefined}
        title={disabledReason ?? undefined}
        className={`absolute right-0 bottom-0 z-10 h-8 rounded-control focus-visible:outline-offset-0 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
        style={{ left: gutter }}
        onKeyDown={(e) => {
          if (disabled) return;
          onKey(e);
        }}
        onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
          if (disabled) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          e.currentTarget.focus({ preventScroll: true });
          seekFromPointer(e.clientX);
        }}
        onPointerMove={(e) => {
          if (dragging.current) seekFromPointer(e.clientX);
          const rect = root.current?.getBoundingClientRect();
          if (rect && e.pointerType === "mouse") setHoverX(Math.min(width, Math.max(0, e.clientX - rect.left - gutter)));
        }}
        onPointerLeave={() => setHoverX(null)}
        onPointerUp={(e) => {
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
        }}
      />
      {hoverX !== null && width > 0 && !disabled && (
        <div
          aria-hidden
          className="float-surface pointer-events-none absolute z-30 px-2 py-1 whitespace-nowrap"
          style={{ left: Math.min(width - 180, Math.max(0, gutter + hoverX - 90)), bottom: 36 }}
        >
          <span className="num text-meta text-fg">{valueText(t0 + (hoverX / width) * (t1 - t0))}</span>
          {(() => {
            const t = t0 + (hoverX / width) * (t1 - t0);
            const near = lanes.flatMap((l) => l.events).find((e) => Math.abs(x(e.time) - hoverX) < 8);
            const inGap = lanes.some((l) => l.gaps.some((g) => t > g.from && t < g.to));
            return (
              <>
                {near && <span className="block text-caption text-fg-2">{near.label}</span>}
                {inGap && <span className="block text-caption text-warning">Missing tracking interval</span>}
              </>
            );
          })()}
        </div>
      )}
      <div
        ref={playhead}
        aria-hidden
        className="pointer-events-none absolute top-0 bottom-0 z-10 w-0.5 bg-accent"
        style={{ left: gutter }}
      />
    </div>
  );
}
