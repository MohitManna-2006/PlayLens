"use client";

import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Ban, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { AnalystPane } from "@/components/analyst/AnalystPane";
import { FieldLegend, TOKEN_LEGEND, type LegendItem } from "@/components/field/FieldControls";
import { OrientationLabel, STAGE_HEIGHT, StageLegend, StagePlaceholder } from "@/components/field/FieldStage";
import { FieldViewport, type FieldApi } from "@/components/field/FieldViewport";
import { allowedRegion, type PlayLabLayer } from "@/components/field/renderer";
import { ReplayDock } from "@/components/replay/ReplayDock";
import { useAnalystStore } from "@/components/shell/Providers";
import { useAnnouncer } from "@/components/ui/Announcer";
import { MenuButton } from "@/components/ui/Menu";
import { StatusState, WarningLine } from "@/components/ui/StatusState";
import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { timelineLane, timeOrigin } from "@/components/play/PlayWorkspace";
import { useAnalystState } from "@/lib/analyst/store";
import type { CounterfactualResult, PlayLabConfig } from "@/lib/contracts";
import { errorMessage, getClient } from "@/lib/datasource";
import { validateEdit } from "@/lib/playlab/validate";
import { downDistance, fixed, matchup, playerLabel, quarterClock, signed } from "@/lib/format";
import { atLeast, useBreakpoint, useReducedMotion } from "@/lib/hooks/useBreakpoint";
import { usePlayData } from "@/lib/hooks/usePlayData";
import { observedFuture } from "@/lib/play/forecast";
import { Clock, useTimeDerived } from "@/lib/replay/clock";
import { actionExtent, frameIndexAt, isPresent, type TrackingSeries } from "@/lib/tracking/series";
import { isFlipped, screenToWorld, toDisplay, toSource, worldToScreen, type Point } from "@/lib/tracking/geometry";

const DISCLAIMER = "Model counterfactual, not causal inference.";

interface Edit {
  playerId: string;
  x: number;
  y: number;
}

function sameEdit(a: Edit | null, b: Edit | null) {
  return !!a && !!b && a.playerId === b.playerId && Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;
}

export function PlayLabWorkspace({ playId }: { playId: string }) {
  const client = getClient();
  const { detail, frames, series, seriesError } = usePlayData(playId);
  const config = useQuery({ queryKey: ["playlab-config", playId], queryFn: ({ signal }) => client.getPlayLabConfig(playId, signal) });
  const bp = useBreakpoint();
  const wide = atLeast(bp, "xl");
  const canEditScreen = atLeast(bp, "lg");
  const analyst = useAnalystStore();
  const { open: analystOpen } = useAnalystState(analyst);
  const { announce } = useAnnouncer();
  const reduced = useReducedMotion();

  const cfg = config.data;
  const editableIndex = series && cfg?.editable_frame_id != null ? series.frameIds.indexOf(cfg.editable_frame_id) : -1;

  const clock = useMemo(() => {
    if (!series) return null;
    const t = series.times;
    return new Clock({ start: t[0], end: t[t.length - 1], stops: t, initial: editableIndex >= 0 ? t[editableIndex] : t[0] });
  }, [series, editableIndex]);
  useEffect(() => () => clock?.dispose(), [clock]);
  const frameIndex = useTimeDerived(clock ?? { getTime: () => 0, subscribe: () => () => {} }, (t) => (series ? frameIndexAt(series.times, t) : 0));
  const atEditable = editableIndex >= 0 && frameIndex === editableIndex;

  const [defenderId, setDefenderId] = useState<string | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [live, setLive] = useState<{ x: number; y: number; problem: string | null } | null>(null);
  const [result, setResult] = useState<{ edit: Edit; data: CounterfactualResult } | null>(null);
  const [run, setRun] = useState<{ status: "idle" | "running" | "error"; error?: string }>({ status: "idle" });
  const [undo, setUndo] = useState<{ edit: Edit; result: typeof result } | null>(null);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const [showObserved, setShowObserved] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [focused, setFocused] = useState(false);
  const undoTimer = useRef<number | null>(null);

  const defIndex = series && defenderId ? series.tracks.findIndex((t) => t.ref.player_id === defenderId) : -1;
  const original: Point | null = useMemo(
    () =>
      series && defIndex >= 0 && editableIndex >= 0 && isPresent(series.tracks[defIndex], editableIndex)
        ? { x: series.tracks[defIndex].x[editableIndex], y: series.tracks[defIndex].y[editableIndex] }
        : null,
    [series, defIndex, editableIndex],
  );
  const activeEdit = edit && edit.playerId === defenderId ? edit : null;
  const proposed: Point | null = live ? { x: live.x, y: live.y } : activeEdit ? { x: activeEdit.x, y: activeEdit.y } : original;
  const changed = !!activeEdit && !!original && Math.hypot(activeEdit.x - original.x, activeEdit.y - original.y) > 0.01;
  const stale = !!result && !sameEdit(result.edit, activeEdit);
  const flipped = series ? isFlipped(series.direction, "normalized") : false;

  // Enter PlayLab paused at the configured editable frame.
  useEffect(() => {
    if (clock && editableIndex >= 0 && series) clock.seek(series.times[editableIndex]);
  }, [clock, editableIndex, series]);

  const region = useMemo(
    () => (cfg && original && cfg.max_displacement_yd !== null ? allowedRegion(original, cfg.max_displacement_yd, cfg.field_bounds, cfg.constraints) : null),
    [cfg, original],
  );

  const eligible = useMemo(() => {
    const s = new Set<number>();
    if (series && cfg) series.tracks.forEach((t, j) => cfg.eligible_player_ids.includes(t.ref.player_id) && s.add(j));
    return s;
  }, [series, cfg]);

  const chooseDefender = (id: string) => {
    if (changed && activeEdit && id !== defenderId) {
      setPendingSwitch(id);
      announce("Only one defender can be modified. Reset the edit to select another defender.");
      return;
    }
    setDefenderId(id);
    setPendingSwitch(null);
    const t = series?.tracks.find((x) => x.ref.player_id === id);
    if (t) announce(`Selected ${playerLabel(t.ref)} ${t.ref.position ?? ""} for editing.`);
  };

  const problemFor = useCallback((p: Point) => (cfg && original ? validateEdit(cfg, original, p) : "Select a defender first."), [cfg, original]);

  const commit = (p: Point, via: "drag" | "key" | "input") => {
    if (!defenderId || !original) return;
    const problem = problemFor(p);
    if (problem) {
      announce(`Position rejected: ${problem}`);
      return false;
    }
    setEdit({ playerId: defenderId, x: p.x, y: p.y });
    if (via !== "drag") announce(`Modified position ${describe(p)}.`);
    return true;
  };

  const describe = (p: Point) => {
    const d = toDisplay(p.x, p.y, flipped);
    const o = original ? toDisplay(original.x, original.y, flipped) : d;
    return `x ${fixed(d.x, 2)}, y ${fixed(d.y, 2)} yards; displacement ${fixed(Math.hypot(d.x - o.x, d.y - o.y), 2)} yards`;
  };

  const resetEdit = () => {
    if (!activeEdit || !original) return;
    const prev = { edit: activeEdit, result };
    const from = { x: activeEdit.x, y: activeEdit.y };
    setResult(null);
    setRun({ status: "idle" });
    if (reduced) {
      setEdit(null);
    } else {
      const start = performance.now();
      const step = (now: number) => {
        const k = Math.min(1, (now - start) / 160);
        const e = 1 - Math.pow(1 - k, 3);
        if (k < 1) {
          setLive({ x: from.x + (original.x - from.x) * e, y: from.y + (original.y - from.y) * e, problem: null });
          requestAnimationFrame(step);
        } else {
          setLive(null);
          setEdit(null);
        }
      };
      requestAnimationFrame(step);
    }
    setUndo(prev);
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), 8000);
    announce("Edit reset. The defender is back at its source position. Undo is available.");
  };

  const undoReset = () => {
    if (!undo) return;
    setDefenderId(undo.edit.playerId);
    setEdit(undo.edit);
    setResult(undo.result);
    setUndo(null);
    announce("Edit restored.");
  };

  useEffect(() => () => {
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
  }, []);

  const runInference = async () => {
    if (!activeEdit || !cfg?.model_version || cfg.editable_frame_id === null || !changed) return;
    const e = activeEdit;
    setRun({ status: "running" });
    try {
      const data = await client.runCounterfactual({
        play_id: playId,
        model_version: cfg.model_version,
        editable_frame_id: cfg.editable_frame_id,
        player_id: e.playerId,
        x: e.x,
        y: e.y,
      });
      setResult({ edit: e, data });
      setRun({ status: "idle" });
      announce(`Inference complete with ${data.model_version}.${data.warnings.length ? " Warning: " + data.warnings[0].message : ""}`);
    } catch (err) {
      setRun({ status: "error", error: errorMessage(err) });
      announce("Inference failed. Your edit is kept.");
    }
  };

  useEffect(() => {
    if (!defenderId) return analyst.bindWorkspace({ getContext: () => ({ kind: "playlab", play_id: playId, editable_frame_id: cfg?.editable_frame_id ?? null, player_id: null, player_label: null }), tools: { client, series } });
    const t = series?.tracks.find((x) => x.ref.player_id === defenderId);
    return analyst.bindWorkspace({
      getContext: () => ({
        kind: "playlab",
        play_id: playId,
        editable_frame_id: cfg?.editable_frame_id ?? null,
        player_id: defenderId,
        player_label: t ? `${playerLabel(t.ref)} ${t.ref.position ?? ""}` : null,
      }),
      // The Analyst never moves a PlayLab defender or runs inference (§15).
      execute: () => ({ ok: false, message: "The Analyst cannot change PlayLab edits or run inference. Use the PlayLab controls." }),
      tools: { client, series },
    });
  }, [analyst, playId, cfg, defenderId, series, client]);

  /* ---------------- render ---------------- */
  const d = detail.data;
  const header = (
    <>
      <WorkspaceHeader
        loading={!d}
        crumbs={[{ label: `Play ${playId}`, href: `/play/${encodeURIComponent(playId)}` }, { label: "PlayLab" }]}
        title="PlayLab"
        subtitle={d ? `${matchup(d)} · ${[quarterClock(d), downDistance(d)].filter(Boolean).join(" · ")}` : undefined}
        meta={[
          <span key="disclaimer" className="font-sans text-body-2 font-medium text-fg">
            {DISCLAIMER}
          </span>,
        ]}
        actions={
          <Link href={`/play/${encodeURIComponent(playId)}`} className="btn btn-quiet">
            <ArrowLeft size={16} strokeWidth={1.5} aria-hidden />
            Back to replay
          </Link>
        }
      />
    </>
  );

  if (config.data && !config.data.available) {
    return (
      <div className="mx-auto max-w-[calc(1680px+2*var(--page-pad))] px-[var(--page-pad)] pb-16">
        {header}
        <StatusState
          kind="unavailable"
          title="No supported editable frame for this play"
          action={
            <Link href={`/play/${encodeURIComponent(playId)}`} className="btn">
              Return to play
            </Link>
          }
        >
          {config.data.unavailable_reason} PlayLab does not choose a frame on your behalf.
        </StatusState>
      </div>
    );
  }

  const layer: PlayLabLayer | null =
    series && cfg
      ? {
          editIndex: atEditable && defIndex >= 0 ? defIndex : null,
          original: atEditable ? original : null,
          proposed: atEditable ? proposed : null,
          invalid: !!live?.problem,
          region: atEditable && canEditScreen ? region : null,
          eligible,
          focusIndex: focused && defIndex >= 0 ? defIndex : null,
          originalPath: result && !stale && atEditable ? (result.data.original.find((p) => p.player_id === result.edit.playerId)?.path ?? null) : null,
          modifiedPath: result && !stale && atEditable ? (result.data.modified.find((p) => p.player_id === result.edit.playerId)?.path ?? null) : null,
          modifiedSamples: null,
          observedFuture:
            showObserved && result && !stale && atEditable && defIndex >= 0 && cfg.horizon_s ? observedFuture(series, defIndex, editableIndex, cfg.horizon_s) : null,
        }
      : null;

  const legend: LegendItem[] = [
    ...(layer?.region ? [{ kind: "ghost", label: "Original" }, { kind: "modified", label: "Modified" }] : []),
    ...(layer?.originalPath ? [{ kind: "original", label: "Original prediction" }] : []),
    ...(layer?.modifiedPath ? [{ kind: "predicted", label: "Modified prediction" }] : []),
    ...(layer?.observedFuture ? [{ kind: "observed", label: "Observed source play" }] : []),
  ];

  const handle = (api: FieldApi) => {
    if (!layer || !proposed || !original || !atEditable || !canEditScreen || defIndex < 0) return null;
    const s = worldToScreen(api.vp, toDisplay(proposed.x, proposed.y, api.flipped));
    const o = toDisplay(original.x, original.y, api.flipped);
    const p = toDisplay(proposed.x, proposed.y, api.flipped);
    const moved = Math.hypot(p.x - o.x, p.y - o.y) > 0.01;
    const pointerTo = (e: PointerEvent<HTMLButtonElement>) => {
      const rect = (e.currentTarget.parentElement as HTMLElement).getBoundingClientRect();
      const w = screenToWorld(api.vp, { x: e.clientX - rect.left, y: e.clientY - rect.top });
      const src = toSource(w.x, w.y, api.flipped);
      const problem = problemFor(src);
      setLive({ x: src.x, y: src.y, problem });
    };
    const keyMove = (e: KeyboardEvent<HTMLButtonElement>) => {
      const stepYd = e.shiftKey ? 1 : 0.25;
      const delta: Record<string, [number, number]> = { ArrowRight: [stepYd, 0], ArrowLeft: [-stepYd, 0], ArrowUp: [0, stepYd], ArrowDown: [0, -stepYd] };
      const dlt = delta[e.key];
      if (!dlt) return;
      e.preventDefault();
      e.stopPropagation();
      const next = toSource(p.x + dlt[0], p.y + dlt[1], api.flipped);
      commit(next, "key");
    };
    return (
      <>
        <button
          type="button"
          aria-label={`Modified position of ${playerLabel(series!.tracks[defIndex].ref)}. Drag, or use arrow keys to move 0.25 yd, Shift for 1 yd. ${describe(proposed)}.`}
          className={`absolute z-20 h-11 w-11 -translate-x-1/2 -translate-y-1/2 rounded-full ${dragging ? "cursor-grabbing" : "cursor-grab"} focus-visible:outline-offset-0`}
          style={{ left: s.x, top: s.y, touchAction: "none" }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={keyMove}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
            pointerTo(e);
          }}
          onPointerMove={(e) => {
            if (dragging) pointerTo(e);
          }}
          onPointerUp={(e) => {
            e.currentTarget.releasePointerCapture(e.pointerId);
            setDragging(false);
            if (live) {
              if (live.problem) {
                announce(`Released outside the allowed region: ${live.problem} Restored the last valid position.`);
              } else {
                commit({ x: live.x, y: live.y }, "drag");
                announce(`Modified position ${describe({ x: live.x, y: live.y })}.`);
              }
            }
            setLive(null);
          }}
        />
        {(moved || live) && (
          <div
            className="num pointer-events-none absolute z-20 bg-field px-1.5 py-0.5 text-meta text-fg"
            style={{ left: Math.min(api.width - 150, s.x + 16), top: Math.max(4, s.y + 14) }}
            aria-hidden
          >
            Δx {signed(p.x - o.x, 2)} · Δy {signed(p.y - o.y, 2)} yd
          </div>
        )}
        {live?.problem && (
          <div
            className="pointer-events-none absolute z-20 flex max-w-64 items-start gap-1 border border-error bg-elevated px-2 py-1 text-caption text-fg"
            style={{ left: Math.min(api.width - 260, s.x + 16), top: Math.max(4, s.y - 44) }}
            role="alert"
          >
            <Ban size={12} strokeWidth={1.5} aria-hidden className="mt-[3px] shrink-0 text-error" />
            {live.problem}
          </div>
        )}
      </>
    );
  };

  const control = cfg && series ? (
    <CounterfactualControl
      series={series}
      cfg={cfg}
      editableIndex={editableIndex}
      atEditable={atEditable}
      flipped={flipped}
      defenderId={defenderId}
      onChoose={chooseDefender}
      pendingSwitch={pendingSwitch}
      onResetAndSelect={() => {
        const next = pendingSwitch;
        resetEdit();
        if (next) {
          setDefenderId(next);
          setPendingSwitch(null);
        }
      }}
      original={original}
      proposed={proposed}
      changed={changed}
      problem={live?.problem ?? null}
      onInput={(p) => commit(p, "input")}
      onRun={runInference}
      run={run}
      result={result}
      stale={stale}
      onReset={resetEdit}
      undo={!!undo}
      onUndo={undoReset}
      showObserved={showObserved}
      onShowObserved={setShowObserved}
      onReturn={() => clock && editableIndex >= 0 && clock.seek(series.times[editableIndex])}
      canEditScreen={canEditScreen}
    />
  ) : (
    <div className="skeleton h-40" />
  );

  return (
    <div className="mx-auto max-w-[calc(1680px+2*var(--page-pad))] px-[var(--page-pad)] pb-16">
      {header}
      <section
        aria-label="PlayLab workspace"
        className={wide ? "grid gap-[var(--gap)]" : undefined}
        style={wide ? { gridTemplateColumns: `minmax(0,1fr) ${analystOpen ? "var(--analyst-w)" : "var(--inspector-w)"}` } : undefined}
      >
        <div className="@container min-w-0">
          <div className="flex h-10 items-center gap-3">
            <p className="num text-meta text-fg">
              Editable frame {cfg?.editable_frame_id ?? "—"} <span className="font-sans text-caption text-fg-2">· Pre-snap · pinned</span>
            </p>
            {!atEditable && editableIndex >= 0 && (
              <button type="button" className="btn btn-sm" onClick={() => clock && series && clock.seek(series.times[editableIndex])}>
                Return to editable frame
              </button>
            )}
            <FieldLegend items={TOKEN_LEGEND} className="ml-auto hidden flex-nowrap lg:flex" />
          </div>
          <div className="relative w-full" style={{ height: STAGE_HEIGHT }}>
            {detail.error || frames.error || seriesError ? (
              <div className="h-full bg-surface p-6">
                <StatusState kind="error" title="Source play could not load" action={<button type="button" className="btn" onClick={() => { detail.refetch(); frames.refetch(); }}>Retry</button>}>
                  {seriesError ?? errorMessage(detail.error ?? frames.error)}
                </StatusState>
              </div>
            ) : series && clock && cfg ? (
              <FieldViewport
                series={series}
                time={clock}
                extent={actionExtent(series, "normalized")}
                orientation="normalized"
                playlab={layer}
                selectedId={null}
                interpolate={!changed}
                hitFilter={(j) => atEditable && eligible.has(j)}
                onSelect={(id) => chooseDefender(id)}
                label={`PlayLab field at editable frame ${cfg.editable_frame_id}. Eligible defenders can be selected; use the defender menu and coordinate inputs as an alternative to dragging.`}
                className="h-full w-full"
              >
                {(api) => (
                  <>
                    <OrientationLabel series={series} orientation="normalized" />
                    {handle(api)}
                    {legend.length > 0 && (
                      <StageLegend>
                        <FieldLegend items={legend} className="justify-end" />
                      </StageLegend>
                    )}
                  </>
                )}
              </FieldViewport>
            ) : (
              <StagePlaceholder>Loading tracking frames</StagePlaceholder>
            )}
          </div>
          {series && clock && (
            <ReplayDock
              clock={clock}
              times={series.times}
              frameIds={series.frameIds}
              origin={timeOrigin(series)}
              lanes={[timelineLane(series)]}
              markers={
                editableIndex >= 0
                  ? [{ key: "editable", time: series.times[editableIndex], label: "Editable", kind: "editable", description: `Editable frame ${cfg?.editable_frame_id}. Return to it.` }]
                  : []
              }
              disabledReason={changed ? "Playback is unavailable during an active edit" : null}
            />
          )}
        </div>
        {wide && (
          <div className="relative min-h-0">
            {analystOpen ? (
              <AnalystPane variant="slot" />
            ) : (
              <aside aria-label="Edit one defender" className="absolute inset-0 flex flex-col border-l border-border">
                <div className="flex min-h-12 shrink-0 items-center border-b border-border px-4">
                  <h2 className="text-panel font-semibold">Edit one defender</h2>
                </div>
                <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto p-4">{control}</div>
              </aside>
            )}
          </div>
        )}
      </section>

      {!wide && analystOpen && <AnalystPane variant={bp === "xs" ? "sheet" : "inline"} className="mt-4" />}
      {!wide && (
        <section aria-label="Edit one defender" className="mt-6 max-w-[680px]">
          <h2 className="text-panel font-semibold">Edit one defender</h2>
          <div className="mt-3">{control}</div>
        </section>
      )}

      <ComparisonTable result={result} stale={stale} />
    </div>
  );
}

function CounterfactualControl({
  series,
  cfg,
  editableIndex,
  atEditable,
  flipped,
  defenderId,
  onChoose,
  pendingSwitch,
  onResetAndSelect,
  original,
  proposed,
  changed,
  problem,
  onInput,
  onRun,
  run,
  result,
  stale,
  onReset,
  undo,
  onUndo,
  showObserved,
  onShowObserved,
  onReturn,
  canEditScreen,
}: {
  series: TrackingSeries;
  cfg: PlayLabConfig;
  editableIndex: number;
  atEditable: boolean;
  flipped: boolean;
  defenderId: string | null;
  onChoose: (id: string) => void;
  pendingSwitch: string | null;
  onResetAndSelect: () => void;
  original: Point | null;
  proposed: Point | null;
  changed: boolean;
  problem: string | null;
  onInput: (p: Point) => void;
  onRun: () => void;
  run: { status: "idle" | "running" | "error"; error?: string };
  result: { edit: Edit; data: CounterfactualResult } | null;
  stale: boolean;
  onReset: () => void;
  undo: boolean;
  onUndo: () => void;
  showObserved: boolean;
  onShowObserved: (v: boolean) => void;
  onReturn: () => void;
  canEditScreen: boolean;
}) {
  const eligible = series.tracks.filter((t) => cfg.eligible_player_ids.includes(t.ref.player_id));
  const current = eligible.find((t) => t.ref.player_id === defenderId);
  const o = original ? toDisplay(original.x, original.y, flipped) : null;
  const p = proposed ? toDisplay(proposed.x, proposed.y, flipped) : null;
  const disp = o && p ? Math.hypot(p.x - o.x, p.y - o.y) : null;
  const pending = pendingSwitch ? series.tracks.find((t) => t.ref.player_id === pendingSwitch) : null;

  if (!canEditScreen) {
    return (
      <StatusState kind="unavailable" compact title="Open on a larger screen to edit">
        PlayLab editing needs at least 1024 px. The source play and any result are shown here.
      </StatusState>
    );
  }

  return (
    <div className="space-y-5">
      {!atEditable && (
        <div className="border-l-2 border-control pl-3">
          <p className="text-body-2 text-fg-2">Editing happens at editable frame {cfg.editable_frame_id}.</p>
          <button type="button" className="btn btn-sm mt-2" onClick={onReturn}>
            Return to editable frame
          </button>
        </div>
      )}
      <div>
        <p className="text-caption text-muted">Defender</p>
        <MenuButton
          label="Defender"
          width={260}
          triggerClassName="btn btn-control mt-1 w-full justify-between"
          triggerContent={<span>{current ? `${playerLabel(current.ref)} · ${current.ref.position ?? "Role unavailable"}` : "Select a defender"}</span>}
          groups={[
            {
              items: eligible.map((t) => ({
                value: t.ref.player_id,
                label: `${playerLabel(t.ref)} · ${t.ref.position ?? "Role unavailable"}`,
                checked: t.ref.player_id === defenderId,
              })),
            },
          ]}
          onSelect={(i) => onChoose(i.value)}
        />
        <p className="mt-1 text-caption text-muted">Or select a defender on the field. {eligible.length} eligible at this frame.</p>
      </div>

      {pending && (
        <div className="border-l-2 border-warning pl-3">
          <WarningLine>Only one defender can be modified at a time.</WarningLine>
          <button type="button" className="btn btn-sm mt-2" onClick={onResetAndSelect}>
            Reset edit and select {playerLabel(pending.ref)}
          </button>
        </div>
      )}

      {current && o && p && (
        <>
          <div>
            <p className="text-caption text-muted">Coordinates · direction-normalized yards</p>
            <dl className="mt-1 grid grid-cols-[80px_1fr_1fr] items-center gap-x-2 gap-y-1.5 text-body-2">
              <span />
              <span className="text-caption text-muted">x</span>
              <span className="text-caption text-muted">y</span>
              <dt className="text-fg-2">Original</dt>
              <dd className="num text-meta text-fg">{fixed(o.x, 2)}</dd>
              <dd className="num text-meta text-fg">{fixed(o.y, 2)}</dd>
              <dt className="text-fg-2">Modified</dt>
              <dd>
                <CoordInput label="Modified x" value={p.x} onCommit={(v) => onInput(toSource(v, p.y, flipped))} disabled={!atEditable} />
              </dd>
              <dd>
                <CoordInput label="Modified y" value={p.y} onCommit={(v) => onInput(toSource(p.x, v, flipped))} disabled={!atEditable} />
              </dd>
            </dl>
            <dl className="mt-3">
              <div className="flex justify-between py-1 text-body-2">
                <dt className="text-fg-2">Displacement</dt>
                <dd className="num text-meta text-fg">{fixed(disp, 2)} yd</dd>
              </div>
              <div className="flex justify-between py-1 text-body-2">
                <dt className="text-fg-2">Limit</dt>
                <dd className="num text-meta text-fg">{cfg.max_displacement_yd === null ? "—" : `${fixed(cfg.max_displacement_yd, 1)} yd`}</dd>
              </div>
            </dl>
            <ul className="mt-1 space-y-0.5 text-caption text-muted">
              <li>Allowed region: within the field, within the limit of the source position{cfg.constraints.length ? "," : "."}</li>
              {cfg.constraints.map((c) => (
                <li key={c.description}>{c.description}.</li>
              ))}
            </ul>
            <p className="mt-2 text-body-2" role="status">
              {problem ? (
                <span className="flex items-start gap-1.5 text-error">
                  <Ban size={14} strokeWidth={1.5} aria-hidden className="mt-[3px] shrink-0" />
                  {problem}
                </span>
              ) : changed ? (
                <span className="text-fg-2">Valid position.</span>
              ) : (
                <span className="text-muted">Drag the defender, use arrow keys on it, or enter coordinates.</span>
              )}
            </p>
          </div>

          <div className="border-t border-border pt-4">
            <dl className="grid grid-cols-[80px_minmax(0,1fr)] gap-x-2 gap-y-1 text-body-2">
              <dt className="text-fg-2">Model</dt>
              <dd>
                <span className="num text-meta text-fg">{cfg.model_version}</span>
                {cfg.model_kind === "mock" && (
                  <div className="mt-0.5">
                    <WarningLine>Development mock · not a trained model</WarningLine>
                  </div>
                )}
                {cfg.model_note && <span className="block text-caption text-muted">{cfg.model_note}</span>}
              </dd>
              <dt className="text-fg-2">Input</dt>
              <dd className="num text-meta text-fg">
                {cfg.input_window ? `Frames ${cfg.input_window.start_frame_id}–${cfg.input_window.end_frame_id}` : "—"}
              </dd>
              <dt className="text-fg-2">Horizon</dt>
              <dd className="num text-meta text-fg">{cfg.horizon_s === null ? "—" : `${fixed(cfg.horizon_s, 1)} s`}</dd>
            </dl>
            <button type="button" className="btn btn-primary mt-3 w-full" disabled={!changed || !!problem || run.status === "running" || !atEditable} onClick={onRun}>
              {run.status === "running" ? "Running inference…" : "Run inference"}
            </button>
            {!changed && <p className="mt-1 text-caption text-muted">Available after a valid, changed position.</p>}
            {changed && (
              <button type="button" className="btn btn-quiet mt-2 w-full" onClick={onReset}>
                <RotateCcw size={14} strokeWidth={1.5} aria-hidden />
                Reset edit
              </button>
            )}
            {undo && (
              <p className="mt-2 flex items-center justify-between text-caption text-fg-2" role="status">
                Edit reset.
                <button type="button" className="btn btn-quiet btn-sm" onClick={onUndo}>
                  Undo
                </button>
              </p>
            )}
          </div>

          {run.status === "error" && (
            <StatusState kind="error" compact title="Inference failed" action={<button type="button" className="btn btn-sm" onClick={onRun}>Retry</button>}>
              {run.error} Your edit is kept.
            </StatusState>
          )}

          {result && (
            <div className="border-t border-border pt-4">
              <p className={`eyebrow ${stale ? "text-warning" : "text-fg-2"}`}>{stale ? "Out of date" : "Modified input · result"}</p>
              <p className="mt-1 text-body-2 font-medium text-fg">{DISCLAIMER}</p>
              {stale ? (
                <p className="mt-1 text-body-2 text-fg-2">The edit changed after this result. Run inference again; the previous prediction is hidden.</p>
              ) : (
                <>
                  <p className="mt-1 text-caption text-muted">
                    Result pinned to {playerLabel(current.ref)} at the position above · latency {fixed(result.data.latency_ms, 1)} ms
                  </p>
                  {result.data.warnings.map((w) => (
                    <div key={w.code} className="mt-2">
                      <WarningLine>{w.message}</WarningLine>
                    </div>
                  ))}
                  {result.data.uncertainty.kind === "none" && <p className="mt-2 text-caption text-muted">This model does not output uncertainty.</p>}
                  <label className="mt-3 flex items-start gap-2 text-body-2">
                    <input type="checkbox" className="mt-0.5" checked={showObserved} onChange={(e) => onShowObserved(e.target.checked)} />
                    <span>
                      <span className="block text-fg">Show observed source play</span>
                      <span className="block text-caption text-muted">Observed source play · not a modified outcome</span>
                    </span>
                  </label>
                </>
              )}
            </div>
          )}
        </>
      )}
      {current && !o && <StatusState kind="unavailable" compact title="Not tracked at the editable frame">This defender has no position at frame {series.frameIds[editableIndex]}.</StatusState>}
    </div>
  );
}

function CoordInput({ label, value, onCommit, disabled }: { label: string; value: number; onCommit: (v: number) => void; disabled?: boolean }) {
  const [text, setText] = useState(value.toFixed(2));
  const [focused, setFocused] = useState(false);
  const shown = focused ? text : value.toFixed(2);
  return (
    <input
      aria-label={label}
      className="input num h-8 px-2 text-meta"
      inputMode="decimal"
      value={shown}
      disabled={disabled}
      onFocus={() => {
        setText(value.toFixed(2));
        setFocused(true);
      }}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => {
        setFocused(false);
        const v = Number(text);
        if (Number.isFinite(v) && Math.abs(v - value) > 1e-9) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(value.toFixed(2));
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function ComparisonTable({ result, stale }: { result: { edit: Edit; data: CounterfactualResult } | null; stale: boolean }) {
  return (
    <section aria-labelledby="cf-heading" className="mt-8">
      <h2 id="cf-heading" className="text-section font-semibold">
        Prediction comparison
        {result && (
          <span className="num ml-3 text-meta font-normal text-fg-2">
            model {result.data.model_version} · horizon {fixed(result.data.horizon_s, 1)} s · input frames {result.data.input_window.start_frame_id}–{result.data.input_window.end_frame_id}
          </span>
        )}
      </h2>
      <p className="mt-1 text-body-2 font-medium text-fg">{DISCLAIMER}</p>
      {!result ? (
        <p className="mt-2 text-body-2 text-fg-2">Move one defender to a valid position and run inference to compare original and modified predictions. Both use the same model, input window, and horizon.</p>
      ) : (
        <div className={`scroll-quiet mt-3 overflow-x-auto ${stale ? "opacity-100" : ""}`}>
          {stale && (
            <div className="mb-2">
              <WarningLine>Out of date: these values belong to a previous edit. Run inference again.</WarningLine>
            </div>
          )}
          <table className={`data-table min-w-[560px] ${stale ? "[&_td.n]:text-muted" : ""}`}>
            <thead>
              <tr>
                <th scope="col">Measure</th>
                <th scope="col" className="n">Original</th>
                <th scope="col" className="n">Modified</th>
                <th scope="col" className="n">Delta</th>
              </tr>
            </thead>
            <tbody>
              {result.data.measures.map((m) => {
                const delta = m.original !== null && m.modified !== null ? m.modified - m.original : null;
                return (
                  <tr key={m.key}>
                    <th scope="row" className="font-normal text-fg-2" title={m.definition}>
                      {m.label}
                    </th>
                    <td className="n">{m.original === null ? "—" : `${fixed(m.original, m.decimals)} ${m.unit}`}</td>
                    <td className="n">{m.modified === null ? "—" : `${fixed(m.modified, m.decimals)} ${m.unit}`}</td>
                    <td className="n">{delta === null ? "—" : `${signed(delta, m.decimals)} ${m.unit}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="mt-2 text-caption text-muted">
            Differences are between two model outputs. They do not show that an outcome would have been prevented or that a position is better.
          </p>
        </div>
      )}
    </section>
  );
}
