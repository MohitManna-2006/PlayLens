"use client";

import { Table2 } from "lucide-react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fixed } from "@/lib/format";

export interface ChartPoint {
  x: number;
  y: number | null;
  lo?: number | null;
  hi?: number | null;
  n: number;
}

export interface ChartSeries {
  key: string;
  label: string;
  served: boolean;
  dash: "solid" | "dashed" | "dotted";
  points: ChartPoint[];
}

function niceTicks(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [min];
  const span = max - min;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 0.5) ?? step0;
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}

/**
 * Report chart: title, one-line definition, plot, legend, source footer, and
 * a data-table alternative with the same values (§13). No decorative cards.
 */
export function ChartFrame({
  title,
  definition,
  footer,
  children,
  table,
  unavailable,
}: {
  title: string;
  definition: string;
  footer: ReactNode;
  children: ReactNode;
  table: ReactNode;
  unavailable?: ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <figure className="min-w-0">
      <div className="flex items-start justify-between gap-3">
        <div>
          <figcaption className="text-panel font-semibold">{title}</figcaption>
          <p className="mt-0.5 text-caption text-fg-2">{definition}</p>
        </div>
        {!unavailable && (
          <button type="button" className="btn btn-quiet btn-sm shrink-0" aria-pressed={showTable} onClick={() => setShowTable((v) => !v)}>
            <Table2 size={14} strokeWidth={1.5} aria-hidden />
            {showTable ? "Show chart" : "Data table"}
          </button>
        )}
      </div>
      <div className={unavailable ? "mt-3" : "mt-3 min-h-60"}>{unavailable ?? (showTable ? table : children)}</div>
      <div className="mt-2 text-caption text-muted">{footer}</div>
    </figure>
  );
}

export function LineChart({
  series,
  xLabel,
  yLabel,
  xFormat,
  yFormat,
  height = 240,
  reference,
  yDomain,
  summary,
}: {
  series: ChartSeries[];
  xLabel: string;
  yLabel: string;
  xFormat: (v: number) => string;
  yFormat: (v: number) => string;
  height?: number;
  reference?: { from: [number, number]; to: [number, number]; label: string };
  yDomain?: [number, number];
  /** Textual takeaway for screen readers (§18). */
  summary: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const xs = useMemo(() => [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b), [series]);
  const ys = series.flatMap((s) => s.points.flatMap((p) => [p.y, p.lo ?? null, p.hi ?? null])).filter((v): v is number => v !== null);
  const y0 = yDomain ? yDomain[0] : 0;
  const y1 = yDomain ? yDomain[1] : Math.max(1e-6, ...ys) * 1.1;
  const m = { l: 64, r: 96, t: 12, b: 40 };
  const w = Math.max(0, width - m.l - m.r);
  const h = height - m.t - m.b;
  const xMin = xs[0] ?? 0;
  const xMax = xs[xs.length - 1] ?? 1;
  const sx = (v: number) => m.l + ((v - xMin) / Math.max(1e-9, xMax - xMin)) * w;
  const sy = (v: number) => m.t + h - ((v - y0) / Math.max(1e-9, y1 - y0)) * h;
  const yTicks = niceTicks(y0, y1, 4);
  const xTicks = xs.length <= 6 ? xs : niceTicks(xMin, xMax, 4);

  const segments = (pts: ChartPoint[]) => {
    const out: string[] = [];
    let d = "";
    for (const p of pts) {
      if (p.y === null) {
        if (d) out.push(d);
        d = "";
        continue;
      }
      d += `${d ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`;
    }
    if (d) out.push(d);
    return out;
  };

  const dash = (s: ChartSeries) => (s.dash === "dashed" ? "6 4" : s.dash === "dotted" ? "1.5 3" : undefined);
  const color = (s: ChartSeries) => (s.served ? "#E7B66B" : "#B7C0C8");
  const cx = cursor !== null ? xs[cursor] : null;

  return (
    <div ref={box} className="relative">
      <p className="sr-only">{summary}</p>
      {width > 0 && (
        <svg
          width={width}
          height={height}
          role="img"
          aria-label={`${yLabel} by ${xLabel}. ${summary} Use arrow keys to inspect values.`}
          tabIndex={0}
          className="block focus-visible:outline-offset-2"
          onKeyDown={(e) => {
            if (!xs.length) return;
            if (e.key === "ArrowRight") setCursor((c) => Math.min(xs.length - 1, (c ?? -1) + 1));
            else if (e.key === "ArrowLeft") setCursor((c) => Math.max(0, (c ?? xs.length) - 1));
            else if (e.key === "Escape") setCursor(null);
            else return;
            e.preventDefault();
          }}
          onBlur={() => setCursor(null)}
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const x = e.clientX - r.left;
            let best = 0;
            xs.forEach((v, i) => {
              if (Math.abs(sx(v) - x) < Math.abs(sx(xs[best]) - x)) best = i;
            });
            setCursor(best);
          }}
          onPointerLeave={() => setCursor(null)}
        >
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={m.l} x2={m.l + w} y1={sy(t)} y2={sy(t)} stroke="#343A40" strokeWidth={1} shapeRendering="crispEdges" />
              <text x={m.l - 8} y={sy(t)} textAnchor="end" dominantBaseline="middle" className="num" fontSize={12} fill="#8D98A3">
                {yFormat(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t} x={sx(t)} y={m.t + h + 16} textAnchor="middle" className="num" fontSize={12} fill="#8D98A3">
              {xFormat(t)}
            </text>
          ))}
          <text x={m.l + w / 2} y={height - 4} textAnchor="middle" fontSize={12} fill="#B7C0C8">
            {xLabel}
          </text>
          <text x={10} y={m.t + h / 2} textAnchor="middle" dominantBaseline="middle" fontSize={12} fill="#B7C0C8" transform={`rotate(-90 10 ${m.t + h / 2})`}>
            {yLabel}
          </text>
          {reference &&
            (() => {
              // Clip the reference line to the plotted x-domain.
              const [ax, ay] = reference.from;
              const [bx, by] = reference.to;
              const at = (x: number) => ay + ((x - ax) / (bx - ax || 1)) * (by - ay);
              const x0 = Math.max(xMin, Math.min(ax, bx));
              const x1 = Math.min(xMax, Math.max(ax, bx));
              return (
                <g>
                  <line x1={sx(x0)} y1={sy(at(x0))} x2={sx(x1)} y2={sy(at(x1))} stroke="#737D87" strokeWidth={1} strokeDasharray="2 3" />
                  <text x={sx(x1) + 6} y={sy(at(x1)) - 10} fontSize={12} fill="#8D98A3" dominantBaseline="middle">
                    {reference.label}
                  </text>
                </g>
              );
            })()}
          {series.map((s) => {
            const band = s.points.filter((p) => p.lo != null && p.hi != null && p.y !== null);
            return band.length > 1 ? (
              <path
                key={`${s.key}-band`}
                d={`M${band.map((p) => `${sx(p.x)},${sy(p.hi!)}`).join("L")}L${band
                  .slice()
                  .reverse()
                  .map((p) => `${sx(p.x)},${sy(p.lo!)}`)
                  .join("L")}Z`}
                fill={s.served ? "rgba(231,182,107,0.12)" : "rgba(183,192,200,0.12)"}
              />
            ) : null;
          })}
          {series.map((s) => (
            <g key={s.key}>
              {segments(s.points).map((d, i) => (
                <path key={i} d={d} fill="none" stroke={color(s)} strokeWidth={s.served ? 2 : 1.5} strokeDasharray={dash(s)} strokeLinecap="round" />
              ))}
              {s.points.map((p) =>
                p.y === null ? null : <circle key={p.x} cx={sx(p.x)} cy={sy(p.y)} r={s.served ? 3 : 2.5} fill={color(s)} />,
              )}
              {(() => {
                const last = [...s.points].reverse().find((p) => p.y !== null);
                return last ? (
                  <text x={sx(last.x) + 8} y={sy(last.y!)} dominantBaseline="middle" fontSize={12} fill={s.served ? "#E7B66B" : "#B7C0C8"}>
                    {s.label}
                  </text>
                ) : null;
              })()}
            </g>
          ))}
          {cx !== null && <line x1={sx(cx)} x2={sx(cx)} y1={m.t} y2={m.t + h} stroke="#737D87" strokeWidth={1} />}
        </svg>
      )}
      {cx !== null && (
        <div
          className="float-surface pointer-events-none absolute z-10 px-2 py-1.5 text-caption"
          style={{ left: Math.min(width - 200, sx(cx) + 12), top: 8 }}
          role="status"
        >
          <p className="num text-meta text-fg">{xLabel}: {xFormat(cx)}</p>
          {series.map((s) => {
            const p = s.points.find((q) => q.x === cx);
            return (
              <p key={s.key} className="flex justify-between gap-4 text-fg-2">
                <span>{s.label}</span>
                <span className="num text-fg">{p && p.y !== null ? `${yFormat(p.y)} (n ${p.n})` : "— missing"}</span>
              </p>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function SeriesTable({ series, xLabel, yLabel, xFormat, yFormat }: { series: ChartSeries[]; xLabel: string; yLabel: string; xFormat: (v: number) => string; yFormat: (v: number) => string }) {
  const xs = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort((a, b) => a - b);
  return (
    <div className="scroll-quiet overflow-x-auto" role="region" aria-label={`${yLabel} data table`} tabIndex={0}>
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">{xLabel}</th>
            {series.map((s) => (
              <th key={s.key} scope="col" className="n">
                {s.label} · {yLabel}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {xs.map((x) => (
            <tr key={x}>
              <th scope="row" className="num font-normal text-fg-2">
                {xFormat(x)}
              </th>
              {series.map((s) => {
                const p = s.points.find((q) => q.x === x);
                return (
                  <td key={s.key} className="n">
                    {p && p.y !== null ? (
                      <>
                        {yFormat(p.y)}
                        {p.lo != null && p.hi != null && <span className="text-muted"> [{yFormat(p.lo)}, {yFormat(p.hi)}]</span>}
                        <span className="text-muted"> n {p.n}</span>
                      </>
                    ) : (
                      <span className="text-muted">— missing</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const fmt = { yd2: (v: number) => fixed(v, 2), s1: (v: number) => `${fixed(v, 1)} s`, pct: (v: number) => `${fixed(v * 100, 0)}%` };
