"use client";

import { MessageSquareText, X } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { MetricRow } from "@/components/ui/MetricRow";
import { StatusState } from "@/components/ui/StatusState";
import type { ModelInfo, PlayDetail, PlayLabConfig } from "@/lib/contracts";
import { codeLabel, downDistance, fixed, playerLabel, playResult, quarterClock, sideLabel } from "@/lib/format";
import { angleToDisplay, isFlipped, toDisplay, toRecorded, type Orientation } from "@/lib/tracking/geometry";
import { DEFINITIONS, nearestOpponent, relativeSpeed } from "@/lib/tracking/measures";
import { isPresent, type TrackingSeries } from "@/lib/tracking/series";

function Section({ title, children, rule }: { title: string; children: ReactNode; rule?: "observed" | "model" }) {
  const ruleClass = rule === "observed" ? "border-l-2 border-control pl-3" : rule === "model" ? "border-l-2 border-dashed border-accent pl-3" : "";
  return (
    <section className="mt-6 first:mt-0">
      <h3 className={rule ? "eyebrow text-fg-2" : "text-panel font-semibold"}>{title}</h3>
      <div className={`mt-2 ${ruleClass}`}>{children}</div>
    </section>
  );
}

function modelKind(m: ModelInfo) {
  return m.kind === "learned" ? "Learned" : m.kind === "baseline" ? "Baseline" : "Development mock";
}

export function Roster({ series, selectedId, onSelect }: { series: TrackingSeries; selectedId: string | null; onSelect: (id: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-x-4">
      {(["offense", "defense"] as const).map((side) => (
        <div key={side}>
          <p className="text-caption text-muted">{sideLabel(side)}</p>
          <ul className="mt-1">
            {series.tracks
              .filter((t) => t.ref.side === side)
              .map((t) => {
                const sel = t.ref.player_id === selectedId;
                return (
                  <li key={t.ref.player_id}>
                    <button
                      type="button"
                      aria-pressed={sel}
                      onClick={() => onSelect(t.ref.player_id)}
                      className={`relative flex h-7 w-full items-center gap-2 rounded-control px-1.5 text-left text-body-2 hover:bg-hover ${sel ? "bg-selected text-fg" : "text-fg-2"}`}
                    >
                      {sel && <span aria-hidden className="absolute top-1 bottom-1 left-0 w-0.5 bg-accent" />}
                      <span className="num w-8 shrink-0 text-meta text-fg">{t.ref.jersey ? `#${t.ref.jersey}` : (t.ref.position ?? "—")}</span>
                      <span className="truncate">{t.ref.jersey ? (t.ref.position ?? "Role unavailable") : (t.ref.name ?? "Name unavailable")}</span>
                    </button>
                  </li>
                );
              })}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function PlayInspector({
  detail,
  series,
  frameIndex,
  orientation,
  selectedId,
  onSelect,
  onClear,
  models,
  modelsError,
  labConfig,
  forecast,
  onAskAnalyst,
  variant,
}: {
  detail: PlayDetail;
  series: TrackingSeries | null;
  frameIndex: number;
  orientation: Orientation;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onClear: () => void;
  models: ModelInfo[] | undefined;
  modelsError: string | null;
  labConfig: PlayLabConfig | undefined;
  forecast: ReactNode;
  onAskAnalyst: () => void;
  variant: "rail" | "flow";
}) {
  const idx = series && selectedId ? series.tracks.findIndex((t) => t.ref.player_id === selectedId) : -1;
  const track = idx >= 0 && series ? series.tracks[idx] : null;
  const frameId = series?.frameIds[frameIndex];

  const heading = track ? (
    <div className="min-w-0">
      <h2 className="truncate text-panel font-semibold">
        {playerLabel(track.ref)} · {track.ref.position ?? "Role unavailable"}
      </h2>
      <p className="text-caption text-fg-2">
        {sideLabel(track.ref.side)}
        {track.ref.role ? ` · ${track.ref.role}` : ""}
        {track.ref.player_to_predict ? " · has held-out future" : ""}
        {track.ref.name ? "" : " · name unavailable"}
      </p>
    </div>
  ) : (
    <h2 className="text-panel font-semibold">Play details</h2>
  );

  const body = (
    <>
      {track && series ? (
        <SelectedPlayer series={series} idx={idx} frameIndex={frameIndex} orientation={orientation} />
      ) : (
        <>
          <Section title="Play context">
            <dl>
              <MetricRow label="Quarter / clock" value={quarterClock(detail) ?? "—"} missingReason="Not supplied" />
              <MetricRow label="Down & distance" value={downDistance(detail) ?? "—"} missingReason="Not supplied" />
              <MetricRow label="Field position" value={detail.yardline_label ?? "—"} missingReason="Not supplied" />
              <MetricRow label="Offense" value={detail.offense ?? "—"} missingReason="Not supplied" />
              <MetricRow label="Defense" value={detail.defense ?? "—"} missingReason="Not supplied" />
              <MetricRow label="Formation" value={codeLabel(detail.context.offense_formation) ?? "—"} missingReason="Not supplied" />
              <MetricRow label="Receiver alignment" value={detail.context.receiver_alignment ?? "—"} missingReason="Not supplied" />
            </dl>
          </Section>
          <Section title="Charted labels">
            <dl>
              <MetricRow
                label="Coverage"
                value={codeLabel(detail.annotations.coverage_type) ?? "—"}
                missingReason="Not supplied"
                definition={`Supplied charting label${detail.annotations.coverage_family ? ` (${codeLabel(detail.annotations.coverage_family)})` : ""}. Describes the play after the fact; not pre-snap information.`}
              />
              <MetricRow label="Target route" value={codeLabel(detail.annotations.target_route) ?? "—"} missingReason="Not supplied" definition="Supplied route label of the targeted receiver." />
              <MetricRow
                label="Play action"
                value={detail.annotations.play_action === null ? "—" : detail.annotations.play_action ? "Yes" : "No"}
                missingReason="Not supplied"
              />
              <MetricRow label="Dropback" value={codeLabel(detail.annotations.dropback_type) ?? "—"} missingReason="Not supplied" />
            </dl>
          </Section>
          <Section title="Outcome · post-play">
            <dl>
              <MetricRow label="Result" value={playResult(detail.outcome) ?? "—"} missingReason="Not supplied" definition="Supplied pass result and yards gained. Known only after the play." />
              {detail.outcome.nullified_by_penalty && <MetricRow label="Penalty" value="Play nullified" />}
            </dl>
          </Section>
          <Section title="Tracking">
            <dl>
              <MetricRow
                label="Observed"
                value={series ? `${series.frameIds.length} frames` : "—"}
                missingReason="Loading"
                definition={`${detail.frame_rate_hz} Hz · ${fixed(detail.tracking.observed_duration_s, 1)} s · ${detail.tracking.player_count} tracked players · ${series?.gaps.length ? `${series.gaps.length} gap(s)` : "no gaps"}${detail.tracking.ball_tracked ? "" : " · ball not tracked"}`}
              />
              <MetricRow
                label="Held-out future"
                value={detail.tracking.future_frame_count ? `${detail.tracking.future_frame_count} frames` : "—"}
                missingReason="None supplied"
                definition={
                  detail.tracking.future_frame_count
                    ? `Actual positions of ${detail.tracking.predicted_player_count} players for ${fixed(detail.tracking.future_duration_s, 1)} s after the last observed frame, from the dataset's output files. Shown only with the Actual future overlay.`
                    : undefined
                }
              />
              {detail.ball_landing && (
                <MetricRow
                  label="Ball landing"
                  value={`${fixed(detail.ball_landing.x, 1)}, ${fixed(detail.ball_landing.y, 1)}`}
                  unit="yd"
                  definition={`Canonical yards; recorded ${fixed(detail.ball_landing.x_raw, 2)}, ${fixed(detail.ball_landing.y_raw, 2)}.${detail.ball_landing.in_field ? "" : " Outside the field rectangle."} A single supplied point; the ball is not tracked.`}
                />
              )}
              <MetricRow label="Dataset" value={detail.provenance.dataset_version} definition={`${detail.provenance.source}. ${detail.provenance.coordinate_convention}.`} />
            </dl>
          </Section>
          <Section title="Model availability">
            <ModelAvailability models={models} error={modelsError} series={series} labConfig={labConfig} />
          </Section>
        </>
      )}

      {track && <div className="mt-6 border-l-2 border-dashed border-accent pl-3">{forecast}</div>}

      {track && (
        <div className="mt-4">
          <button type="button" className="btn w-full" onClick={onAskAnalyst}>
            <MessageSquareText size={14} strokeWidth={1.5} aria-hidden />
            Ask Analyst about this player
          </button>
        </div>
      )}

      {series && (
        <Section title={track ? "Players" : "Select a player"}>
          {!track && <p className="mb-2 text-body-2 text-fg-2">Select a player on the field or from this roster to inspect position, speed, and separation.</p>}
          <Roster series={series} selectedId={selectedId} onSelect={onSelect} />
        </Section>
      )}
    </>
  );

  if (variant === "flow") {
    return (
      <section aria-label="Inspector" className="mt-6 border-t border-border pt-4">
        <div className="flex items-start justify-between gap-2">
          {heading}
          {track && (
            <button type="button" className="btn btn-quiet btn-sm" onClick={onClear}>
              Clear selection
            </button>
          )}
        </div>
        {track && <p className="num mt-1 text-meta text-muted">Frame {frameId} · Player {track.ref.player_id}</p>}
        <div className="mt-4 grid items-start gap-x-8 gap-y-6 md:grid-cols-2 [&>*]:mt-0">{body}</div>
      </section>
    );
  }

  return (
    <aside aria-label="Inspector" className="absolute inset-0 flex flex-col border-l border-border">
      <div className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-border px-4 py-2">
        {heading}
        {track && (
          <button type="button" className="btn btn-quiet btn-icon" aria-label="Clear selection (Escape)" onClick={onClear}>
            <X size={16} strokeWidth={1.5} aria-hidden />
          </button>
        )}
      </div>
      {track && (
        <p className="num shrink-0 border-b border-border px-4 py-1.5 text-meta text-muted">
          Frame {frameId} · Player {track.ref.player_id}
        </p>
      )}
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto p-4">{body}</div>
    </aside>
  );
}

function SelectedPlayer({ series, idx, frameIndex, orientation }: { series: TrackingSeries; idx: number; frameIndex: number; orientation: Orientation }) {
  const t = series.tracks[idx];
  const present = isPresent(t, frameIndex);
  if (!present) {
    return (
      <Section title="Observed data" rule="observed">
        <StatusState kind="unavailable" compact title="Not tracked at this frame">
          No position is shown or estimated for this player at frame {series.frameIds[frameIndex]}.
        </StatusState>
      </Section>
    );
  }
  const flipped = isFlipped(series.direction, orientation);
  const p = toDisplay(t.x[frameIndex], t.y[frameIndex], flipped);
  const recorded = toRecorded({ x: t.x[frameIndex], y: t.y[frameIndex] }, series.direction);
  const angle = (v: number) => (Number.isFinite(v) ? angleToDisplay(v, flipped) : NaN);
  const near = nearestOpponent(series, idx, frameIndex);
  const rel = near ? relativeSpeed(series, idx, near.playerIndex, frameIndex) : null;
  const opp = near ? series.tracks[near.playerIndex].ref : null;
  return (
    <Section title={`Observed data · frame ${series.frameIds[frameIndex]}`} rule="observed">
      <dl>
        <MetricRow
          label="Position"
          value={`${fixed(p.x, 1)}, ${fixed(p.y, 1)}`}
          unit="yd"
          definition={`x, y in ${orientation === "normalized" ? "direction-normalized" : "source"} field yards. Canonical ${fixed(t.x[frameIndex], 2)}, ${fixed(t.y[frameIndex], 2)}; recorded ${fixed(recorded.x, 2)}, ${fixed(recorded.y, 2)}.`}
        />
        <MetricRow label="Speed" value={fixed(t.s[frameIndex], 1)} unit="yd/s" missingReason="Not tracked" />
        <MetricRow label="Acceleration" value={fixed(t.a[frameIndex], 1)} unit="yd/s²" missingReason="Not tracked" definition="Tracked acceleration magnitude." />
        <MetricRow
          label="Direction"
          value={fixed(angle(t.dir[frameIndex]), 0)}
          unit="°"
          missingReason="Not tracked"
          definition="Tracked direction of movement in this view: 0° points up the field view (+y), increasing clockwise."
        />
        <MetricRow
          label="Orientation"
          value={fixed(angle(t.o[frameIndex]), 0)}
          unit="°"
          missingReason="Not tracked"
          definition="Tracked body orientation in this view, same angle convention as direction."
        />
        <MetricRow
          label={opp ? `Separation from ${playerLabel(opp)}` : "Separation"}
          value={fixed(near?.distance, 1)}
          unit="yd"
          missingReason="No tracked opponent"
          definition={DEFINITIONS.separation}
        />
        <MetricRow label="Relative speed" value={fixed(rel, 1)} unit="yd/s" missingReason="Speed or direction not tracked" definition={DEFINITIONS.relativeSpeed} />
      </dl>
    </Section>
  );
}

function ModelAvailability({
  models,
  error,
  series,
  labConfig,
}: {
  models: ModelInfo[] | undefined;
  error: string | null;
  series: TrackingSeries | null;
  labConfig: PlayLabConfig | undefined;
}) {
  if (error) return <StatusState kind="error" compact title="Model list unavailable">{error}</StatusState>;
  if (!models) return <div className="skeleton h-16 w-full" aria-label="Loading models" />;
  const find = (task: ModelInfo["task"]) => models.find((m) => m.task === task && m.served) ?? null;
  const rows: Array<{ task: string; model: ModelInfo | null; status: string }> = [
    {
      task: "Trajectory forecast",
      model: find("trajectory"),
      status: find("trajectory")
        ? series?.snapIndex !== null && series && find("trajectory")!.trajectory?.origin_after_snap
          ? `Origins from frame ${series.frameIds[series.snapIndex!]}`
          : "Available"
        : "No model served",
    },
    {
      task: "Similar plays",
      model: find("retrieval"),
      status: find("retrieval") ? (series && series.snapIndex === null ? "Unavailable for this play: no snap event" : "On request") : "No model served",
    },
    {
      task: "PlayLab",
      model: find("counterfactual"),
      status: !find("counterfactual")
        ? "No model served"
        : labConfig
          ? labConfig.available
            ? `Editable frame ${labConfig.editable_frame_id}`
            : `Unavailable: ${labConfig.unavailable_reason}`
          : "Checking",
    },
  ];
  return (
    <ul className="space-y-3">
      {rows.map((r) => (
        <li key={r.task}>
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-body-2 text-fg">{r.task}</span>
            {r.model && (
              <Link href={`/evaluation?model=${encodeURIComponent(r.model.model_version)}`} className="num link-quiet truncate text-meta">
                {r.model.model_version}
              </Link>
            )}
          </div>
          <p className="text-caption text-fg-2">
            {r.model ? `${modelKind(r.model)} · ` : ""}
            {r.status}
          </p>
        </li>
      ))}
    </ul>
  );
}
