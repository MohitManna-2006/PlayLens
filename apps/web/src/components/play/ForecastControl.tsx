"use client";

import Link from "next/link";
import { StatusState } from "@/components/ui/StatusState";
import type { ModelInfo, TrajectoryPrediction } from "@/lib/contracts";
import { fixed, ms } from "@/lib/format";
import { inputWindow, originProblem, validHorizon } from "@/lib/play/forecast";
import type { TrackingSeries } from "@/lib/tracking/series";

export interface PinnedForecast {
  originIndex: number;
  originFrameId: number;
  horizon: number;
  status: "running" | "ready" | "error";
  result?: TrajectoryPrediction;
  error?: string;
}

export interface ForecastState {
  enabled: boolean;
  horizon: number;
  pinned: PinnedForecast | null;
  showUncertainty: boolean;
  showObservedFuture: boolean;
}

function kindLabel(m: ModelInfo) {
  const k = m.kind === "learned" ? "Learned model" : m.kind === "baseline" ? "Baseline" : "Development mock";
  const e = m.evaluation_status === "evaluated" ? "evaluated" : m.evaluation_status === "pending" ? "evaluation pending" : "not evaluated";
  return `${k} · ${e}`;
}

export function DashSample() {
  return (
    <svg width="20" height="6" aria-hidden className="inline-block shrink-0">
      <line x1="0" y1="3" x2="20" y2="3" stroke="#E7B66B" strokeWidth="2" strokeDasharray="6 4" />
    </svg>
  );
}

/**
 * Compact model control group (§7 forecast review). Shows the observed input
 * window, model version, and horizon before any result; changing the origin
 * requires an explicit Update forecast.
 */
export function ForecastControl({
  model,
  series,
  frameIndex,
  selectedId,
  state,
  onHorizon,
  onRun,
  onReturnToOrigin,
  onUncertainty,
  onObservedFuture,
  onClose,
}: {
  model: ModelInfo | null;
  series: TrackingSeries;
  frameIndex: number;
  selectedId: string | null;
  state: ForecastState;
  onHorizon: (h: number) => void;
  onRun: (originIndex: number) => void;
  onReturnToOrigin: () => void;
  onUncertainty: (v: boolean) => void;
  onObservedFuture: (v: boolean) => void;
  onClose: () => void;
}) {
  const traj = model?.trajectory ?? null;
  const pinned = state.pinned;
  const currentProblem = originProblem(series, frameIndex, model);
  const beforeOrigin = pinned?.status === "ready" && frameIndex < pinned.originIndex;
  const showOriginIndex = pinned ? pinned.originIndex : frameIndex;
  const win = inputWindow(series, showOriginIndex, model);
  const originMoved = !!pinned && frameIndex !== pinned.originIndex && !beforeOrigin;
  const horizonChanged = pinned && pinned.horizon !== state.horizon;
  const result = pinned?.status === "ready" ? pinned.result : undefined;
  const playerResult = result && selectedId ? result.players.find((p) => p.player_id === selectedId) : undefined;

  if (!model || !traj) {
    return (
      <StatusState kind="unavailable" compact title="No trajectory model is served">
        Predicted paths appear here once the API serves a trajectory model.
      </StatusState>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="eyebrow flex items-center gap-2 text-fg-2">
          <DashSample /> Model prediction
        </h3>
        <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
          Hide
        </button>
      </div>
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 text-body-2">
        <dt className="text-fg-2">Model</dt>
        <dd>
          <span className="num text-meta text-fg">{model.model_version}</span>
          <span className="block text-caption text-muted">{kindLabel(model)}</span>
        </dd>
        <dt className="text-fg-2">Origin</dt>
        <dd className="num text-meta text-fg">
          Frame {series.frameIds[showOriginIndex]}
          <span className="ml-1 font-sans text-caption text-muted">{pinned ? "pinned" : "current frame"}</span>
        </dd>
        <dt className="text-fg-2">Input</dt>
        <dd className="num text-meta text-fg">
          {win ? `Frames ${win[0]}–${win[1]}` : "—"}
          <span className="ml-1 font-sans text-caption text-muted">observed</span>
        </dd>
        <dt className="self-center text-fg-2">Horizon</dt>
        <dd>
          <div role="radiogroup" aria-label="Forecast horizon" className="segmented">
            {traj.horizons_s.map((h) => (
              <button key={h} type="button" role="radio" aria-checked={state.horizon === h} className="num" onClick={() => onHorizon(h)}>
                {fixed(h, 1)} s
              </button>
            ))}
          </div>
        </dd>
      </dl>

      {!pinned && (
        <div>
          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={!!currentProblem}
            onClick={() => onRun(frameIndex)}
          >
            Run forecast from frame {series.frameIds[frameIndex]}
          </button>
          {currentProblem && <p className="mt-1 text-caption text-muted">{currentProblem}</p>}
          {!currentProblem && <p className="mt-1 text-caption text-muted">{traj.origin_rule}</p>}
        </div>
      )}

      {pinned?.status === "running" && (
        <p className="text-body-2 text-fg-2" role="status">
          Running forecast…
        </p>
      )}

      {pinned?.status === "error" && (
        <StatusState
          kind="error"
          compact
          title="Forecast failed"
          action={
            <button type="button" className="btn btn-sm" onClick={() => onRun(pinned.originIndex)}>
              Retry
            </button>
          }
        >
          {pinned.error} The observed replay is unaffected.
        </StatusState>
      )}

      {beforeOrigin && (
        <div className="border-l-2 border-control pl-3">
          <p className="text-body-2 text-fg-2">The current frame is before the forecast origin, so the forecast is hidden. Observed replay.</p>
          <button type="button" className="btn btn-sm mt-2" onClick={onReturnToOrigin}>
            Return to forecast origin
          </button>
        </div>
      )}

      {pinned && pinned.status !== "running" && (originMoved || horizonChanged) && !beforeOrigin && (
        <div>
          <button
            type="button"
            className="btn w-full"
            disabled={!!currentProblem && frameIndex !== pinned.originIndex}
            onClick={() => onRun(horizonChanged && !originMoved ? pinned.originIndex : frameIndex)}
          >
            {horizonChanged && !originMoved ? `Update forecast · ${fixed(state.horizon, 1)} s` : `Update forecast to frame ${series.frameIds[frameIndex]}`}
          </button>
          {currentProblem && originMoved && <p className="mt-1 text-caption text-muted">{currentProblem}</p>}
        </div>
      )}

      {result && !beforeOrigin && (
        <div className="space-y-2">
          {!selectedId ? (
            <p className="text-body-2 text-fg-2">Select a player to show their predicted path.</p>
          ) : !playerResult || playerResult.path.length === 0 ? (
            <p className="text-body-2 text-fg-2">No prediction for this player: not tracked through the input window.</p>
          ) : (
            <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1 text-body-2">
              <dt className="text-fg-2">Valid horizon</dt>
              <dd className="num text-meta text-fg">{fixed(validHorizon(result, selectedId), 1)} s</dd>
              <dt className="text-fg-2">Latency</dt>
              <dd className="num text-meta text-fg">
                {ms(result.latency_ms)}
                <span className="block font-sans text-caption text-muted">{result.latency_scope}</span>
              </dd>
            </dl>
          )}
          {result.uncertainty.kind !== "none" ? (
            <label className="flex items-start gap-2 text-body-2">
              <input type="checkbox" className="mt-0.5" checked={state.showUncertainty} onChange={(e) => onUncertainty(e.target.checked)} />
              <span>
                <span className="block text-fg">Show uncertainty</span>
                <span className="block text-caption text-muted">{result.uncertainty.description}</span>
              </span>
            </label>
          ) : (
            <p className="text-caption text-muted">This model does not output uncertainty.</p>
          )}
          <label className="flex items-start gap-2 text-body-2">
            <input type="checkbox" className="mt-0.5" checked={state.showObservedFuture} onChange={(e) => onObservedFuture(e.target.checked)} />
            <span>
              <span className="block text-fg">Show observed future</span>
              <span className="block text-caption text-muted">Tracked positions after the origin. Never part of the model input.</span>
            </span>
          </label>
          {result.warnings.map((w) => (
            <p key={w} className="text-caption text-warning">
              {w}
            </p>
          ))}
          <Link href={`/evaluation?model=${encodeURIComponent(result.model_version)}`} className="link text-caption">
            Evaluation for {result.model_version}
          </Link>
        </div>
      )}
    </div>
  );
}
