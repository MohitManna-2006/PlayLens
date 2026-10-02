"use client";

import { useQuery } from "@tanstack/react-query";
import { FlaskConical, GitCompareArrows } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { AnalystPane } from "@/components/analyst/AnalystPane";
import {
  changeOverlay,
  FieldLegend,
  overlayLegend,
  OverlayControl,
  tokenLegend,
  ViewMenu,
  type GroundTruthAvailability,
  type ViewMode,
} from "@/components/field/FieldControls";
import { FrameLabel, OrientationLabel, STAGE_HEIGHT, StageLegend, StageNote, StagePlaceholder } from "@/components/field/FieldStage";
import { FieldViewport } from "@/components/field/FieldViewport";
import { StageBoundary } from "@/components/field/StageBoundary";
import { FrameDataTable } from "@/components/field/FrameDataTable";
import { DEFAULT_OVERLAYS, type ForecastLayer, type GroundTruthLayer, type OverlayState } from "@/components/field/renderer";
import { ReplayDock, type TimeOrigin } from "@/components/replay/ReplayDock";
import type { TimelineLane, TimelineMarker } from "@/components/replay/Timeline";
import { useAnalystStore } from "@/components/shell/Providers";
import { useAnnouncer } from "@/components/ui/Announcer";
import { Identifier } from "@/components/ui/Identifier";
import { Popover } from "@/components/ui/Popover";
import { StatusState } from "@/components/ui/StatusState";
import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import type { AnalystAction } from "@/lib/analyst/schema";
import { useAnalystState, type ActionOutcome } from "@/lib/analyst/store";
import { ApiError } from "@/lib/contracts";
import { errorMessage, getClient } from "@/lib/datasource";
import { downDistance, elapsed, fixed, matchup, playerLabel, quarterClock } from "@/lib/format";
import { atLeast, useBreakpoint } from "@/lib/hooks/useBreakpoint";
import { pushRecent } from "@/lib/hooks/recent";
import { usePlayData, usePlayFuture } from "@/lib/hooks/usePlayData";
import { parsePlayId } from "@/lib/playId";
import { compareToActual, forecastOriginIndex, forecastPaths, isFixedOrigin, observedFuture, predictedAt } from "@/lib/play/forecast";
import { buildGroundTruth } from "@/lib/play/groundTruth";
import { Clock, useTimeDerived, type TimeSource } from "@/lib/replay/clock";
import { handleReplayKey } from "@/lib/replay/keys";
import { FULL_FIELD, type Orientation } from "@/lib/tracking/geometry";
import { DEFINITIONS, nearestOpponent, relativeSpeed } from "@/lib/tracking/measures";
import { actionExtent, frameIndexAt, isPresent, type TrackingSeries } from "@/lib/tracking/series";
import { EvidenceStrip, type StripItem } from "./EvidenceStrip";
import { DashSample, ForecastControl, type ForecastState } from "./ForecastControl";
import { PlayInspector } from "./PlayInspector";
import { SimilarPlays } from "./SimilarPlays";

const IDLE: TimeSource = { getTime: () => 0, subscribe: () => () => {} };

export function timelineLane(series: TrackingSeries, id = "play", label?: string, offset = 0): TimelineLane {
  const origin = series.snapIndex !== null ? series.times[series.snapIndex] : series.times[0];
  return {
    id,
    label,
    observed: [series.times[0] + offset, series.times[series.times.length - 1] + offset],
    gaps: series.gaps.map((g) => ({ from: g.startTime + offset, to: g.endTime + offset })),
    events: series.events.map((e) => ({
      key: `${e.code}-${e.frameId}`,
      time: e.time + offset,
      label: e.label,
      kind: e.kind,
      description: `${e.label} · frame ${e.frameId} · ${elapsed(e.time - origin)}. Jump to this frame.`,
    })),
  };
}

export function timeOrigin(series: TrackingSeries): TimeOrigin {
  return series.snapIndex !== null ? { time: series.times[series.snapIndex], kind: "snap" } : { time: series.times[0], kind: "recording" };
}

export function PlayWorkspace({ playId }: { playId: string }) {
  const client = getClient();
  const params = useSearchParams();
  const validId = parsePlayId(playId) !== null;
  // Set when this play was opened from another play's similar-plays list.
  const similarParam = params.get("similar_to");
  const similarTo = similarParam && similarParam !== playId && parsePlayId(similarParam) !== null ? similarParam : null;
  const { detail, frames, series, seriesError } = usePlayData(validId ? playId : null);
  const models = useQuery({ queryKey: ["models"], queryFn: ({ signal }) => client.listModels(signal) });
  const served = (task: "trajectory" | "retrieval" | "counterfactual") => models.data?.find((m) => m.task === task && m.served) ?? null;
  // PlayLab configuration exists only for a served counterfactual model.
  const labConfig = useQuery({
    queryKey: ["playlab-config", playId],
    queryFn: ({ signal }) => client.getPlayLabConfig(playId, signal),
    enabled: !!served("counterfactual"),
  });
  const bp = useBreakpoint();
  const wide = atLeast(bp, "xl");
  const analyst = useAnalystStore();
  const { open: analystOpen } = useAnalystState(analyst);
  const { announce } = useAnnouncer();

  const [selectedId, setSelectedId] = useState<string | null>(params.get("player"));
  const [overlays, setOverlays] = useState<OverlayState>(DEFAULT_OVERLAYS);
  const [view, setView] = useState<ViewMode>("action");
  const [orientationPref, setOrientation] = useState<Orientation>("normalized");
  const [framingIndex, setFramingIndex] = useState<number | null>(null);
  const [flash, setFlash] = useState<{ time: number; id: number } | null>(null);
  const [forecast, setForecast] = useState<ForecastState>({
    enabled: false,
    horizon: 2,
    pinned: null,
    showUncertainty: false,
    showObservedFuture: false,
  });

  const orientation: Orientation = series && series.direction === null ? "source" : orientationPref;

  const clock = useMemo(() => {
    if (!series) return null;
    const t = series.times;
    const requested = Number(params.get("frame"));
    const fi = series.frameIds.indexOf(requested);
    return new Clock({
      start: t[0],
      end: t[t.length - 1],
      stops: t,
      gaps: series.gaps.map((g) => ({ from: g.startTime, to: g.endTime })),
      initial: fi >= 0 ? t[fi] : series.snapIndex !== null ? t[series.snapIndex] : t[0],
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series]);
  useEffect(() => () => clock?.dispose(), [clock]);
  const source = clock ?? IDLE;
  const frameIndex = useTimeDerived(source, (t) => (series ? frameIndexAt(series.times, t) : 0));

  useEffect(() => {
    if (detail.data) pushRecent(detail.data, [quarterClock(detail.data), downDistance(detail.data)].filter(Boolean).join(" · "));
  }, [detail.data]);

  const extent = useMemo(() => {
    if (!series || view === "full") return FULL_FIELD;
    return actionExtent(series, orientation, framingIndex ?? series.times.length - 1);
  }, [series, view, orientation, framingIndex]);

  const selIndex = series && selectedId ? series.tracks.findIndex((t) => t.ref.player_id === selectedId) : -1;
  const trajModel = served("trajectory");
  const fixedOrigin = isFixedOrigin(trajModel);
  const horizonOptions = trajModel?.trajectory?.horizons_s ?? [];
  const horizon = horizonOptions.includes(forecast.horizon) ? forecast.horizon : (horizonOptions[horizonOptions.length - 1] ?? forecast.horizon);
  // The held-out future is fetched for the overlay, or to score a ready real-data forecast against it.
  const future = usePlayFuture(detail.data, overlays.actualFuture || (fixedOrigin && forecast.pinned?.status === "ready"));
  const pinned = forecast.pinned;
  const inReview = !!pinned && pinned.status === "ready" && frameIndex >= pinned.originIndex;

  /* ---- selection ---- */
  const select = useCallback(
    (id: string | null) => {
      setSelectedId(id);
      if (!series || !id) {
        if (!id) announce("Selection cleared.");
        return;
      }
      const j = series.tracks.findIndex((t) => t.ref.player_id === id);
      const t = series.tracks[j];
      const i = frameIndexAt(series.times, source.getTime());
      const near = isPresent(t, i) ? nearestOpponent(series, j, i) : null;
      announce(
        `Selected ${playerLabel(t.ref)} ${t.ref.position ?? ""}, ${t.ref.side}. ${
          isPresent(t, i) ? `Speed ${Number.isFinite(t.s[i]) ? t.s[i].toFixed(1) : "unavailable"} yd/s${near ? `, separation ${near.distance.toFixed(1)} yd` : ""}.` : "Not tracked at this frame."
        }`,
      );
    },
    [series, source, announce],
  );

  /* ---- overlays ---- */
  const patchOverlays = useCallback(
    (patch: Partial<OverlayState>) => {
      let msg: string | null = null;
      setOverlays((o) => {
        const r = changeOverlay(o, patch);
        msg = r.announcement;
        return r.next;
      });
      if (msg) announce(msg);
    },
    [announce],
  );

  /* ---- forecast ---- */
  const forecastRun = useRef(0);
  const runForecast = useCallback(
    async (originIndex: number) => {
      if (!series || !clock) return;
      clock.pause();
      clock.seek(series.times[originIndex]);
      const run = ++forecastRun.current;
      const originFrameId = series.frameIds[originIndex];
      setForecast((f) => ({ ...f, pinned: { originIndex, originFrameId, horizon, status: "running" } }));
      try {
        const result = await client.predictTrajectory({
          play_id: playId,
          model_version: trajModel?.model_version ?? null,
          origin_frame_id: originFrameId,
          horizon_s: horizon,
          player_ids: null,
        });
        if (run !== forecastRun.current) return;
        setForecast((f) => ({ ...f, pinned: { originIndex, originFrameId, horizon, status: "ready", result } }));
        if (view === "action") setFramingIndex(originIndex);
        announce(`Forecast ready from frame ${originFrameId}, horizon ${horizon.toFixed(1)} s, model ${result.model_version}.`);
      } catch (e) {
        if (run !== forecastRun.current) return;
        setForecast((f) => ({ ...f, pinned: { originIndex, originFrameId, horizon, status: "error", error: errorMessage(e) } }));
        announce("Forecast failed. The observed replay is unaffected.");
      }
    },
    [series, clock, client, playId, horizon, trajModel, view, announce],
  );

  // Announce leaving forecast review when the user scrubs before the origin.
  const wasReview = useRef(false);
  useEffect(() => {
    if (!pinned || pinned.status !== "ready") {
      wasReview.current = false;
      return;
    }
    if (wasReview.current && !inReview) announce("Observed replay: the current frame is before the forecast origin. The last forecast is kept.");
    if (!wasReview.current && inReview) announce("Forecast review.");
    wasReview.current = inReview;
  }, [inReview, pinned, announce]);

  const forecastLayer: ForecastLayer | null = useMemo(() => {
    if (!series || !forecast.enabled || !inReview || !pinned?.result) return null;
    const { primary, others } = forecastPaths(series, pinned.result, pinned.originIndex, selectedId, fixedOrigin);
    if (!primary && !others.length) return null;
    const sample = primary ? pinned.result.players.find((x) => x.player_id === selectedId) : undefined;
    return {
      playerIndex: primary?.playerIndex ?? -1,
      origin: primary?.origin ?? { x: 0, y: 0 },
      path: primary?.path ?? [],
      valid: primary?.valid ?? [],
      samples: forecast.showUncertainty && sample ? sample.samples : null,
      showUncertainty: forecast.showUncertainty,
      // Pinned-origin (fixture) models compare against later tracked frames; real-data forecasts use the
      // held-out actual future overlay instead, because no tracked frames follow the origin.
      observedFuture:
        primary && !fixedOrigin && forecast.showObservedFuture ? observedFuture(series, primary.playerIndex, pinned.originIndex, pinned.horizon) : null,
      others,
    };
  }, [series, forecast, inReview, pinned, selectedId, fixedOrigin]);

  const actualComparison = useMemo(
    () => (pinned?.status === "ready" && pinned.result && future.data ? compareToActual(pinned.result, future.data) : null),
    [pinned, future.data],
  );

  /* ---- ground truth after the observed window ---- */
  const groundTruth: GroundTruthLayer | null = useMemo(
    () => (series ? buildGroundTruth(series, detail.data, future.data, { future: overlays.actualFuture, landing: overlays.ballLanding }) : null),
    [series, detail.data, overlays.actualFuture, overlays.ballLanding, future.data],
  );

  const groundTruthAvailability: GroundTruthAvailability | undefined = detail.data
    ? {
        futureReason:
          detail.data.tracking.future_frame_count === 0 || detail.data.tracking.predicted_player_count === 0
            ? "No held-out future is supplied for this play"
            : future.isError
              ? `Could not load: ${errorMessage(future.error)}`
              : null,
        futureHint: `Held-out positions from the dataset's output files: ${detail.data.tracking.predicted_player_count} players over ${fixed(detail.data.tracking.future_duration_s, 1)} s after the last observed frame. Ground truth, not a prediction.`,
        landingReason: detail.data.ball_landing ? null : "No landing point is supplied for this play",
      }
    : undefined;

  /* ---- announcements for user seeks ---- */
  const seekTimer = useRef<number | null>(null);
  const announceFrame = useCallback(() => {
    if (!series) return;
    if (seekTimer.current) window.clearTimeout(seekTimer.current);
    seekTimer.current = window.setTimeout(() => {
      const i = frameIndexAt(series.times, source.getTime());
      const o = timeOrigin(series);
      announce(`Frame ${series.frameIds[i]}, ${elapsed(series.times[i] - o.time)} ${o.kind === "snap" ? "from snap" : "from recording start"}.`);
    }, 350);
  }, [series, source, announce]);

  /* ---- Analyst binding ---- */
  const live = useRef({ selectedId, frameIndex, overlays });
  useEffect(() => {
    live.current = { selectedId, frameIndex, overlays };
    analyst.notifyContext();
  }, [selectedId, frameIndex, overlays, analyst]);

  useEffect(() => {
    if (!series || !clock) return analyst.bindWorkspace({ getContext: () => ({ kind: "play", play_id: playId, player_id: null, player_label: null, frame_id: null }) });
    return analyst.bindWorkspace({
      getContext: () => {
        const { selectedId: sid, frameIndex: fi } = live.current;
        const t = sid ? series.tracks.find((x) => x.ref.player_id === sid) : null;
        return {
          kind: "play",
          play_id: playId,
          player_id: sid,
          player_label: t ? `${playerLabel(t.ref)}${t.ref.position ? ` ${t.ref.position}` : ""}` : null,
          frame_id: series.frameIds[fi] ?? null,
        };
      },
      execute: (a: AnalystAction): ActionOutcome => {
        if (a.type === "jump_to_frame") {
          const i = series.frameIds.indexOf(a.frame_id);
          if (i < 0) return { ok: false, message: `Frame ${a.frame_id} is not in this play's tracking data.` };
          const prev = clock.getTime();
          clock.pause();
          clock.seek(series.times[i]);
          setFlash({ time: series.times[i], id: Date.now() });
          announceFrame();
          return { ok: true, message: `Moved to frame ${a.frame_id}.`, undo: () => clock.seek(prev) };
        }
        if (a.type === "focus_player") {
          if (!series.tracks.some((t) => t.ref.player_id === a.player_id)) return { ok: false, message: `Player ${a.player_id} is not in this play.` };
          const prev = live.current.selectedId;
          clock.pause();
          select(a.player_id);
          return { ok: true, message: `Selected player ${a.player_id}.`, undo: () => select(prev) };
        }
        if (a.type === "show_overlay") {
          const prev = live.current.overlays;
          clock.pause();
          const map: Record<string, Partial<OverlayState>> = {
            trails: { trails: a.state },
            velocity: { velocity: a.state ? "selected" : "off" },
            acceleration: { acceleration: a.state },
            nearest_opponent: { relationship: a.state ? "nearest_opponent" : "none" },
            interaction_graph: { relationship: a.state ? "interaction_graph" : "none" },
          };
          patchOverlays(map[a.overlay]);
          return { ok: true, message: `${a.state ? "Showing" : "Hid"} ${a.overlay.replace(/_/g, " ")}.`, undo: () => setOverlays(prev) };
        }
        return { ok: false, message: "This action is not available in Play." };
      },
      tools: { client, series, datasetVersion: detail.data?.provenance.dataset_version ?? null },
    });
  }, [analyst, series, clock, playId, client, detail.data, select, patchOverlays, announceFrame]);

  /* ---- keyboard ---- */
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (!clock) return;
    handleReplayKey(e, clock, {
      canPlay: true,
      onSeek: announceFrame,
      onEscape: () => {
        if (selectedId) {
          select(null);
          return true;
        }
        return false;
      },
    });
  };

  /* ---- render ---- */
  const d = detail.data;
  const loadError = detail.error ?? frames.error;
  const notFound = detail.isError && detail.error instanceof ApiError && detail.error.status === 404;
  if (!validId || notFound) {
    return (
      <div className="mx-auto max-w-[680px] px-[var(--page-pad)] py-12">
        <StatusState
          kind="empty"
          title={validId ? `Play ${playId} was not found` : `${playId} is not a PlayLens play ID`}
          action={
            <Link href="/explore" className="btn">
              Back to Explore
            </Link>
          }
        >
          {validId
            ? "The play ID does not exist in the current dataset."
            : "Play IDs combine the game and play numbers, for example 2023091008-3826."}
        </StatusState>
      </div>
    );
  }

  const origin = series ? timeOrigin(series) : null;
  const markers: TimelineMarker[] =
    series && pinned && pinned.status !== "error"
      ? [
          {
            key: "origin",
            time: series.times[pinned.originIndex],
            label: "Origin",
            kind: "origin",
            description: `Forecast origin · frame ${pinned.originFrameId}. Jump to origin.`,
          },
        ]
      : [];
  const span =
    series && pinned?.status === "ready" && !fixedOrigin
      ? { from: series.times[pinned.originIndex], to: Math.min(series.times[series.times.length - 1], series.times[pinned.originIndex] + pinned.horizon), label: `Forecast horizon ${pinned.horizon.toFixed(1)} s` }
      : null;

  const stripItems: StripItem[] = [];
  if (series && selIndex >= 0 && isPresent(series.tracks[selIndex], frameIndex)) {
    const near = nearestOpponent(series, selIndex, frameIndex);
    if (near) {
      stripItems.push({ key: "sep", label: `Separation from ${playerLabel(series.tracks[near.playerIndex].ref)}`, value: near.distance, unit: "yd", definition: DEFINITIONS.separation, source: "computed in browser from tracking frames" });
      const rel = relativeSpeed(series, selIndex, near.playerIndex, frameIndex);
      if (rel !== null) stripItems.push({ key: "rel", label: "Relative speed", value: rel, unit: "yd/s", definition: DEFINITIONS.relativeSpeed, source: "tracked speed and direction" });
    }
    if (inReview && pinned?.result && frameIndex > pinned.originIndex) {
      const pred = predictedAt(pinned.result, selectedId!, series.times[pinned.originIndex], series.times[frameIndex]);
      const t = series.tracks[selIndex];
      if (pred) {
        stripItems.push({
          key: "err",
          label: "Forecast error",
          value: Math.hypot(pred.x - t.x[frameIndex], pred.y - t.y[frameIndex]),
          unit: "yd",
          definition: DEFINITIONS.forecastError,
          source: `${pinned.result.model_version}, origin frame ${pinned.originFrameId}`,
        });
      }
    }
  }

  const forecastControl =
    series && forecast.enabled ? (
      <ForecastControl
        model={trajModel}
        series={series}
        frameIndex={frameIndex}
        selectedId={selectedId}
        state={{ ...forecast, horizon }}
        originIndex={forecastOriginIndex(series, trajModel, frameIndex)}
        actualFutureShown={fixedOrigin ? overlays.actualFuture : forecast.showObservedFuture}
        comparison={actualComparison}
        comparisonPending={fixedOrigin && pinned?.status === "ready" && future.isFetching}
        onHorizon={(h) => setForecast((f) => ({ ...f, horizon: h }))}
        onRun={runForecast}
        onReturnToOrigin={() => pinned && clock?.seek(series.times[pinned.originIndex])}
        onUncertainty={(v) => setForecast((f) => ({ ...f, showUncertainty: v }))}
        onObservedFuture={(v) => (fixedOrigin ? patchOverlays({ actualFuture: v }) : setForecast((f) => ({ ...f, showObservedFuture: v })))}
        onClose={() => setForecast((f) => ({ ...f, enabled: false }))}
      />
    ) : (
      <div>
        <h3 className="eyebrow flex items-center gap-2 text-fg-2">
          <DashSample /> Model prediction
        </h3>
        <p className="mt-2 text-body-2 text-fg-2">
          {!trajModel
            ? "No trajectory model is served."
            : fixedOrigin
              ? `Predicted paths come from ${trajModel.model_version}, starting at the last observed frame. Opt in to run a forecast.`
              : `Predicted paths come from ${trajModel.model_version}. Opt in to review a forecast from a pinned origin.`}
        </p>
        {trajModel && (
          <button
            type="button"
            className="btn btn-sm mt-2"
            onClick={() => {
              clock?.pause();
              setForecast((f) => ({ ...f, enabled: true }));
            }}
          >
            Show predicted path
          </button>
        )}
      </div>
    );

  const inspector = d ? (
    <PlayInspector
      variant={wide ? "rail" : "flow"}
      detail={d}
      series={series}
      frameIndex={frameIndex}
      orientation={orientation}
      selectedId={selectedId}
      onSelect={(id) => select(id)}
      onClear={() => select(null)}
      models={models.data}
      modelsError={models.error ? errorMessage(models.error) : null}
      labConfig={labConfig.data}
      forecast={forecastControl}
      onAskAnalyst={() => analyst.setOpen(true)}
    />
  ) : null;

  const legendExtra = forecastLayer
    ? [
        { kind: "predicted", label: "Predicted · model" },
        ...(forecastLayer.samples ? [{ kind: "samples", label: "Sampled futures" }] : []),
        ...(forecastLayer.observedFuture ? [{ kind: "observed", label: "Observed future" }] : []),
      ]
    : [];
  const legend = overlayLegend(overlays, legendExtra);
  const tokens = tokenLegend(!series || !!series.ball);
  const modeLabel = inReview ? "Forecast review" : "Observed replay";

  return (
    <div className="mx-auto max-w-[calc(1680px+2*var(--page-pad))] px-[var(--page-pad)] pb-16">
      <WorkspaceHeader
        loading={detail.isPending}
        crumbs={[{ label: "Explore", href: "/explore" }, { label: `Play ${playId}` }]}
        title={d ? matchup(d) : `Play ${playId}`}
        subtitle={d ? (d.description ?? <span className="text-muted">No supplied description</span>) : undefined}
        meta={
          !d
            ? ["Play metadata unavailable"]
            : [
                quarterClock(d) ?? "Clock unavailable",
                downDistance(d) ?? "Down unavailable",
                d.yardline_label ?? "Field position unavailable",
                <Identifier key="id" value={d.id} label="Play ID" />,
              ]
        }
        actions={
          <>
            {similarTo && (
              <Link
                href={`/compare?left=${encodeURIComponent(similarTo)}&right=${encodeURIComponent(playId)}`}
                className="btn"
                aria-label={`Compare with play ${similarTo}`}
              >
                <GitCompareArrows size={16} strokeWidth={1.5} aria-hidden />
                <span className="hidden md:inline">Compare with {similarTo}</span>
              </Link>
            )}
            <Link href={`/compare?left=${encodeURIComponent(playId)}`} className="btn btn-quiet" aria-label="Compare">
              <GitCompareArrows size={16} strokeWidth={1.5} aria-hidden />
              <span className="hidden md:inline">Compare</span>
            </Link>
            <Link href={`/playlab/${encodeURIComponent(playId)}`} className="btn btn-quiet" aria-label="Open PlayLab">
              <FlaskConical size={16} strokeWidth={1.5} aria-hidden />
              <span className="hidden md:inline">Open PlayLab</span>
            </Link>
          </>
        }
      />

      <section
        aria-label="Replay workspace"
        onKeyDown={onKeyDown}
        className={wide ? "grid gap-[var(--gap)]" : undefined}
        style={
          wide
            ? {
                gridTemplateColumns: `minmax(0,1fr) ${analystOpen ? "var(--analyst-w)" : "var(--inspector-w)"}`,
                transition: "grid-template-columns var(--dur-pane) var(--ease-out)",
              }
            : undefined
        }
      >
        <div className="@container min-w-0">
          <div className="flex min-h-10 flex-wrap items-center gap-2 py-1 md:h-10 md:flex-nowrap md:py-0">
            <ViewMenu
              view={view}
              orientation={orientation}
              directionKnown={series ? series.direction !== null : true}
              onView={(v) => {
                setView(v);
                announce(v === "full" ? "Full field view." : "Action view.");
              }}
              onOrientation={(o) => {
                setOrientation(o);
                announce(o === "source" ? "Source view: coordinates as recorded." : "Direction normalized: offense attacks left to right.");
              }}
            />
            <button
              type="button"
              className="btn btn-control"
              onClick={() => {
                if (series) setFramingIndex(inReview && pinned ? pinned.originIndex : null);
                announce("Framing recomputed.");
              }}
              title="Recompute the camera for the current mode"
            >
              Fit
            </button>
            <OverlayControl
              overlays={overlays}
              onChange={patchOverlays}
              hasSelection={!!selectedId}
              predicted={forecast.enabled}
              onPredicted={(v) => {
                if (v) clock?.pause();
                setForecast((f) => ({ ...f, enabled: v }));
              }}
              predictedDisabledReason={trajModel ? null : "No trajectory model is served"}
              groundTruth={groundTruthAvailability}
            />
            <div className="ml-auto flex min-w-0 items-center gap-3">
              {atLeast(bp, "lg") ? (
                <FieldLegend items={tokens} className="flex-nowrap justify-end" />
              ) : (
                <Popover
                  label="Legend"
                  placement="bottom-end"
                  className="p-3"
                  width={220}
                  trigger={(props) => (
                    <button type="button" {...props} className="btn btn-quiet">
                      Legend
                    </button>
                  )}
                >
                  {() => <FieldLegend items={tokens} className="flex-col items-start" />}
                </Popover>
              )}
              <span className={`shrink-0 text-caption ${inReview ? "text-accent" : "text-fg-2"}`} aria-live="polite">
                {modeLabel}
              </span>
            </div>
          </div>

          <div className="relative w-full" style={{ height: STAGE_HEIGHT }}>
            {loadError || seriesError ? (
              <div className="h-full w-full bg-surface p-6">
                <StatusState
                  kind="error"
                  title="Replay could not load"
                  action={
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        detail.refetch();
                        frames.refetch();
                      }}
                    >
                      Retry replay
                    </button>
                  }
                >
                  {seriesError ?? errorMessage(loadError)}
                </StatusState>
              </div>
            ) : series && clock ? (
              <StageBoundary>
              <FieldViewport
                  series={series}
                  time={clock}
                  extent={extent}
                  orientation={orientation}
                  overlays={overlays}
                  selectedId={selectedId}
                  forecast={forecastLayer}
                  groundTruth={groundTruth}
                  onSelect={(id) => select(id)}
                  label={`Football field replay for play ${playId}. ${series.tracks.length} tracked players. Use the roster or frame data table to select players.`}
                  className="h-full w-full"
                >
                  {() => (
                    <>
                      <OrientationLabel series={series} orientation={orientation} />
                      <FrameLabel series={series} time={clock} origin={origin?.time ?? null} />
                      {!series.ball && (
                        <StageNote>
                          {overlays.actualFuture && future.isFetching
                            ? "Loading actual future"
                            : overlays.ballLanding && groundTruth?.landing
                              ? "Ball not tracked · landing spot shown"
                              : "Ball not tracked in this play"}
                        </StageNote>
                      )}
                      {legend.length > 0 && (
                        <StageLegend>
                          <FieldLegend items={legend} className="justify-end" />
                        </StageLegend>
                      )}
                    </>
                  )}
              </FieldViewport>
              </StageBoundary>
            ) : (
              <StagePlaceholder>Loading tracking frames</StagePlaceholder>
            )}
          </div>

          {series && clock && origin ? (
            <ReplayDock
              clock={clock}
              times={series.times}
              frameIds={series.frameIds}
              origin={origin}
              lanes={[timelineLane(series)]}
              markers={markers}
              span={span}
              flash={flash}
              onUserSeek={announceFrame}
            />
          ) : (
            <div className="h-24 border-t border-border" aria-hidden>
              {!loadError && !seriesError && (
                <>
                  <div className="skeleton mt-3 h-4 w-64" />
                  <div className="skeleton mt-8 h-1 w-full" />
                </>
              )}
            </div>
          )}
        </div>

        {wide && <div className="relative min-h-0">{analystOpen ? <AnalystPane variant="slot" /> : inspector}</div>}
      </section>

      {!wide && analystOpen && <AnalystPane variant={bp === "xs" ? "sheet" : "inline"} className="mt-4" />}
      {!wide && inspector}

      {series && (
        <EvidenceStrip
          frameId={series.frameIds[frameIndex]}
          player={selIndex >= 0 ? series.tracks[selIndex].ref : null}
          items={stripItems}
        />
      )}
      <SimilarPlays key={playId} playId={playId} query={detail.data ?? null} />
      {series && clock && (
        <FrameDataTable series={series} time={clock} orientation={orientation} selectedId={selectedId} onSelect={(id) => select(id)} />
      )}
    </div>
  );
}
