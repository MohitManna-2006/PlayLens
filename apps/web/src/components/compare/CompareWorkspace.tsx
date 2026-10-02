"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { AnalystPane } from "@/components/analyst/AnalystPane";
import { changeOverlay, FieldLegend, overlayLegend, OverlayControl, tokenLegend, ViewMenu, type ViewMode } from "@/components/field/FieldControls";
import { OrientationLabel, STAGE_HEIGHT, StageLegend, StageNote, StagePlaceholder } from "@/components/field/FieldStage";
import { FieldViewport } from "@/components/field/FieldViewport";
import { FrameDataTable } from "@/components/field/FrameDataTable";
import { DEFAULT_OVERLAYS, type OverlayState } from "@/components/field/renderer";
import { ReplayDock } from "@/components/replay/ReplayDock";
import { Timeline, type TimelineLane } from "@/components/replay/Timeline";
import { useAnalystStore } from "@/components/shell/Providers";
import { useAnnouncer } from "@/components/ui/Announcer";
import { MenuButton } from "@/components/ui/Menu";
import { StatusState, WarningLine } from "@/components/ui/StatusState";
import { Tooltip } from "@/components/ui/Tooltip";
import { WorkspaceHeader } from "@/components/workspace/WorkspaceHeader";
import { timelineLane, timeOrigin } from "@/components/play/PlayWorkspace";
import type { AnalystAction } from "@/lib/analyst/schema";
import { useAnalystState, type ActionOutcome } from "@/lib/analyst/store";
import { align, ALIGN_MODES, DEFAULT_ALIGN, phaseAvailable, snapAvailable, type Alignment, type AlignMode } from "@/lib/compare/alignment";
import { masterClock, resync, sideEnded, sideFrameIndex, sideTime, unsync, type Side } from "@/lib/compare/sync";
import type { CompareResponse, Evidence, PlaySummary } from "@/lib/contracts";
import { isRetrievalDown, isUnavailable } from "@/lib/contracts";
import { errorMessage, getClient } from "@/lib/datasource";
import { codeLabel, cosine, downDistance, elapsed, fixed, matchup, percent, playerLabel, quarterClock, signed } from "@/lib/format";
import { atLeast, useBreakpoint } from "@/lib/hooks/useBreakpoint";
import { usePlayData } from "@/lib/hooks/usePlayData";
import { SPEEDS, useClockState, useTimeDerived, type Clock, type TimeSource } from "@/lib/replay/clock";
import { handleReplayKey } from "@/lib/replay/keys";
import { FULL_FIELD, unionExtent } from "@/lib/tracking/geometry";
import { actionExtent, frameIndexAt, type TrackingSeries } from "@/lib/tracking/series";

function mappedLane(series: TrackingSeries, id: Side, map: (t: number) => number): TimelineLane {
  const base = timelineLane(series, id, id === "left" ? "Left" : "Right");
  return {
    ...base,
    observed: [map(series.times[0]), map(series.times[series.times.length - 1])],
    gaps: series.gaps.map((g) => ({ from: map(g.startTime), to: map(g.endTime) })),
    events: series.events.map((e, k) => ({ ...base.events[k], time: map(e.time) })),
  };
}

export function CompareWorkspace() {
  const params = useSearchParams();
  const router = useRouter();
  const leftId = params.get("left");
  const rightId = params.get("right");
  const alignParam = params.get("align");
  const requested: AlignMode = ALIGN_MODES.find((m) => m === alignParam) ?? DEFAULT_ALIGN;
  const client = getClient();
  const L = usePlayData(leftId);
  const R = usePlayData(rightId);
  const bp = useBreakpoint();
  const analyst = useAnalystStore();
  const { open: analystOpen } = useAnalystState(analyst);
  const { announce } = useAnnouncer();

  const cmp = useQuery({
    queryKey: ["compare", leftId, rightId],
    queryFn: ({ signal }) => client.compare({ left_play_id: leftId!, right_play_id: rightId! }, signal),
    enabled: !!leftId && !!rightId && leftId !== rightId,
    retry: false,
  });

  const [overlays, setOverlays] = useState<OverlayState>(DEFAULT_OVERLAYS);
  const [view, setView] = useState<ViewMode>("action");
  const [linked, setLinked] = useState(true);
  const [selected, setSelected] = useState<{ side: Side; id: string } | null>(null);
  const [manual, setManual] = useState<{ left: string; right: string } | null>(null);
  const [picking, setPicking] = useState(false);
  const [mobileSide, setMobileSide] = useState<Side>("left");

  const ls = L.series;
  const rs = R.series;
  const alignment: Alignment | null = useMemo(() => (ls && rs ? align(ls, rs, requested) : null), [ls, rs, requested]);

  const master = useMemo(() => (alignment ? masterClock(alignment) : null), [alignment]);
  useEffect(() => () => master?.dispose(), [master]);

  const [locals, setLocals] = useState<{ left: Clock; right: Clock } | null>(null);
  useEffect(() => () => {
    locals?.left.dispose();
    locals?.right.dispose();
  }, [locals]);

  const unlink = () => {
    if (!ls || !rs || !alignment || !master) return;
    setLocals(unsync(master, alignment, ls, rs));
    setLinked(false);
    announce("Sync off. Each play now has its own replay controls.");
  };
  const relink = () => {
    if (locals && alignment && master) resync(master, alignment, locals);
    setLinked(true);
    setLocals(null);
    announce("Sync on, from the left play's position.");
  };

  const idle: TimeSource = useMemo(() => ({ getTime: () => 0, subscribe: () => () => {} }), []);
  // Each field reads its own time from the master clock: continuous while playing,
  // the aligned real frame when paused (it also redraws on play/pause).
  const synced = (side: Side, s: TrackingSeries | null): TimeSource => {
    if (!linked && locals) return locals[side];
    if (!master || !alignment || !s) return idle;
    return {
      getTime: () => sideTime(alignment, s, side, master.getTime(), master.getState().playing),
      subscribe: (l) => {
        const a = master.subscribe(l);
        const b = master.subscribeState(l);
        return () => {
          a();
          b();
        };
      },
    };
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const leftSource: TimeSource = useMemo(() => synced("left", ls), [linked, locals, master, alignment, ls, idle]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rightSource: TimeSource = useMemo(() => synced("right", rs), [linked, locals, master, alignment, rs, idle]);

  const leftEnded = useTimeDerived(master ?? idle, (tau) => (linked && alignment && ls ? sideEnded(alignment, ls, "left", tau) : false));
  const rightEnded = useTimeDerived(master ?? idle, (tau) => (linked && alignment && rs ? sideEnded(alignment, rs, "right", tau) : false));

  const showLastObserved = () => {
    if (!ls || !rs) return;
    if (linked && master && alignment) {
      master.seek(alignment.mode === "origin" ? 0 : alignment.fromLeft(ls.times[ls.times.length - 1]));
    } else if (locals) {
      locals.left.toEnd();
      locals.right.toEnd();
    }
    announce("Showing the last observed frame.");
  };

  const extent = useMemo(() => {
    if (!ls || !rs || view === "full") return FULL_FIELD;
    return unionExtent(actionExtent(ls, "normalized"), actionExtent(rs, "normalized"));
  }, [ls, rs, view]);

  const counterpart = useMemo(() => {
    if (!selected) return null;
    if (manual && selected.side === "left" && manual.left === selected.id) return { id: manual.right, method: "Manual pairing" };
    if (manual && selected.side === "right" && manual.right === selected.id) return { id: manual.left, method: "Manual pairing" };
    const c = cmp.data?.correspondence;
    const pair = c?.pairs.find((p) => (selected.side === "left" ? p.left_player_id : p.right_player_id) === selected.id);
    return pair && c ? { id: selected.side === "left" ? pair.right_player_id : pair.left_player_id, method: c.method } : null;
  }, [selected, manual, cmp.data]);

  const onSelect = (side: Side, id: string) => {
    if (picking && selected && side !== selected.side) {
      setManual(selected.side === "left" ? { left: selected.id, right: id } : { left: id, right: selected.id });
      setPicking(false);
      announce("Manual pairing set.");
      return;
    }
    setSelected({ side, id });
  };

  /* ---- Analyst ---- */
  const live = useRef({ selected, label: alignment?.label ?? "Normalized progress" });
  useEffect(() => {
    live.current = { selected, label: alignment?.label ?? "Normalized progress" };
    analyst.notifyContext();
  }, [selected, alignment, analyst]);
  useEffect(() => {
    if (!leftId) return;
    return analyst.bindWorkspace({
      getContext: () => {
        const sel = live.current.selected;
        const s = sel ? (sel.side === "left" ? ls : rs) : null;
        const t = sel && s ? s.tracks.find((x) => x.ref.player_id === sel.id) : null;
        return {
          kind: "compare",
          left_play_id: leftId,
          right_play_id: rightId,
          alignment: live.current.label,
          player_id: sel?.id ?? null,
          player_label: t ? `${playerLabel(t.ref)} ${t.ref.position ?? ""} (${sel!.side})` : null,
        };
      },
      execute: (a: AnalystAction): ActionOutcome => {
        if (a.type === "jump_to_frame") {
          const side: Side | null = a.play_id === leftId ? "left" : a.play_id === rightId ? "right" : null;
          const s = side === "left" ? ls : side === "right" ? rs : null;
          if (!side || !s || !alignment) return { ok: false, message: "That play is not in this comparison." };
          const i = s.frameIds.indexOf(a.frame_id);
          if (i < 0) return { ok: false, message: `Frame ${a.frame_id} is not in play ${a.play_id}.` };
          if (linked && master) {
            const prev = master.getTime();
            master.seek(side === "left" ? alignment.fromLeft(s.times[i]) : alignment.fromRight(s.times[i]));
            return { ok: true, message: `Moved to frame ${a.frame_id} of the ${side} play (${alignment.label}).`, undo: () => master.seek(prev) };
          }
          const c = side === "left" ? locals?.left : locals?.right;
          if (!c) return { ok: false, message: "Replay is not ready." };
          const prev = c.getTime();
          c.seek(s.times[i]);
          return { ok: true, message: `Moved the ${side} play to frame ${a.frame_id}.`, undo: () => c.seek(prev) };
        }
        if (a.type === "show_overlay") {
          const prev = overlays;
          const map: Record<string, Partial<OverlayState>> = {
            trails: { trails: a.state },
            velocity: { velocity: a.state ? "selected" : "off" },
            acceleration: { acceleration: a.state },
            nearest_opponent: { relationship: a.state ? "nearest_opponent" : "none" },
            interaction_graph: { relationship: a.state ? "interaction_graph" : "none" },
          };
          setOverlays((o) => changeOverlay(o, map[a.overlay]).next);
          return { ok: true, message: `${a.state ? "Showing" : "Hid"} ${a.overlay.replace(/_/g, " ")} on both fields.`, undo: () => setOverlays(prev) };
        }
        if (a.type === "focus_player") {
          const side: Side | null = a.play_id === leftId ? "left" : a.play_id === rightId ? "right" : null;
          if (!side) return { ok: false, message: "That play is not in this comparison." };
          const prev = live.current.selected;
          setSelected({ side, id: a.player_id });
          return { ok: true, message: `Selected player ${a.player_id} in the ${side} play.`, undo: () => setSelected(prev) };
        }
        return { ok: false, message: "This action is not available in Compare." };
      },
      tools: { client, compare: { left: ls, right: rs } },
    });
  }, [analyst, leftId, rightId, ls, rs, alignment, linked, master, locals, overlays, client]);

  /* ---- layout measurement for the Analyst rule (§8) ---- */
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const gap = atLeast(bp, "2xl") ? 24 : 16;
  const analystW = atLeast(bp, "2xl") ? 384 : 360;
  const sidePane = analystOpen && atLeast(bp, "xl") && (width - analystW - gap - gap) / 2 >= 480;
  const stacked = !atLeast(bp, "lg");
  const single = bp === "xs";

  const setAlign = (m: AlignMode) => {
    const p = new URLSearchParams(params.toString());
    p.set("align", m);
    router.replace(`/compare?${p}`, { scroll: false });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const c = linked ? master : null;
    if (!c) return;
    handleReplayKey(e, c, {
      canPlay: true,
      onEscape: () => {
        if (picking) {
          setPicking(false);
          return true;
        }
        if (selected) {
          setSelected(null);
          return true;
        }
        return false;
      },
    });
  };

  if (!leftId) {
    return (
      <div className="mx-auto max-w-[680px] px-[var(--page-pad)] py-12">
        <StatusState
          kind="empty"
          title="Choose a play to compare"
          action={
            <Link href="/explore" className="btn">
              Go to Explore
            </Link>
          }
        >
          Compare opens from a play. Open a play and choose Compare, or use Compare on any Explore row.
        </StatusState>
      </div>
    );
  }

  const legend = overlayLegend(overlays);
  const fieldFor = (side: Side) => {
    const P = side === "left" ? L : R;
    const s = side === "left" ? ls : rs;
    const id = side === "left" ? leftId : rightId;
    const ended = side === "left" ? leftEnded : rightEnded;
    const source = side === "left" ? leftSource : rightSource;
    if (!id) return <ChooseRight leftId={leftId} />;
    const err = P.detail.error ?? P.frames.error;
    const selId = selected?.side === side ? selected.id : null;
    const cpId = selected && selected.side !== side ? (counterpart?.id ?? null) : null;
    return (
      <div className="@container min-w-0">
        <PlayColumnHeader side={side} summary={P.detail.data ?? null} playId={id} split={cmp.data ? cmp.data[side].split : null} />
        <div className="relative w-full" style={{ height: STAGE_HEIGHT }}>
          {err || P.seriesError ? (
            <div className="h-full bg-surface p-6">
              <StatusState
                kind="error"
                title={`The ${side} play could not load`}
                action={
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      P.detail.refetch();
                      P.frames.refetch();
                    }}
                  >
                    Retry
                  </button>
                }
              >
                {P.seriesError ?? errorMessage(err)} The other play remains inspectable; synced playback waits until both are valid.
              </StatusState>
            </div>
          ) : s ? (
            <FieldViewport
              series={s}
              time={source}
              extent={extent}
              orientation="normalized"
              overlays={overlays}
              selectedId={selId}
              counterpartId={cpId}
              ended={ended}
              onSelect={(pid) => onSelect(side, pid)}
              label={`${side === "left" ? "Left" : "Right"} field, play ${id}`}
              className="h-full w-full"
            >
              {() => (
                <>
                  <OrientationLabel series={s} orientation="normalized" />
                  {!s.ball && <StageNote>Ball not tracked</StageNote>}
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
        {s && <SideFrameLine series={s} source={source} ended={ended} lastFrameId={cmp.data?.[side].last_frame_id ?? null} />}
        {!linked && locals && s && (
          <ReplayDock
            clock={side === "left" ? locals.left : locals.right}
            times={s.times}
            frameIds={s.frameIds}
            origin={timeOrigin(s)}
            lanes={[timelineLane(s)]}
          />
        )}
      </div>
    );
  };

  const leftSummary = L.detail.data;
  const sim = cmp.data?.similarity ?? null;
  const modeItem = (m: AlignMode, label: string, hint: string, available = true) => ({
    value: m,
    label,
    hint: available ? hint : "Needs the same events in both plays (this dataset has none)",
    checked: alignment?.mode === m,
    disabled: !available,
  });
  return (
    <div ref={container} className="mx-auto max-w-[calc(1680px+2*var(--page-pad))] px-[var(--page-pad)] pb-16">
      <WorkspaceHeader
        crumbs={[{ label: `Play ${leftId}`, href: `/play/${encodeURIComponent(leftId)}` }, { label: "Compare" }]}
        title="Compare"
        subtitle={leftSummary ? `${matchup(leftSummary)}${R.detail.data ? ` vs ${matchup(R.detail.data)}` : ""}` : undefined}
        meta={[
          <span key="l" className="font-sans text-caption text-fg-2">
            {linked ? "Sync on ·" : "Sync off (independent) ·"}
          </span>,
          <MenuButton
            key="m"
            label="Sync mode"
            triggerClassName="inline-flex h-[18px] items-center gap-1 rounded-control font-sans text-caption text-fg hover:underline"
            triggerContent={<span>{alignment?.label ?? "Normalized progress"}</span>}
            width={340}
            disabled={!alignment}
            groups={[
              {
                items: [
                  modeItem("progress", "Normalized progress", "First observed frame (0%) to last observed frame (100%) together; speeds differ"),
                  modeItem("origin", "Last observed frame", "Real seconds before each play's last observed frame (the forecast origin)"),
                  modeItem("start", "From recording start", "Real seconds from each play's first observed frame"),
                  modeItem("snap", "Snap-relative", "Real seconds from each play's snap", !!(ls && rs && snapAvailable(ls, rs))),
                  modeItem("phase", "Phase aligned", "Maps snap, throw, and arrival; speeds differ", !!(ls && rs && phaseAvailable(ls, rs))),
                ],
              },
            ]}
            onSelect={(i) => setAlign(i.value as AlignMode)}
          />,
          ...(sim
            ? [
                <span key="s" className="font-sans text-caption text-fg-2">
                  <span className="text-fg">#{sim.right_rank_from_left}</span> nearest to the left play of {sim.rank_pool.toLocaleString()} · cosine{" "}
                  <span className="num">{cosine(sim.cosine_similarity)}</span>
                </span>,
              ]
            : []),
        ]}
        actions={
          <Link href={`/explore?compare_left=${encodeURIComponent(leftId)}`} className="btn btn-quiet">
            {rightId ? "Replace right play" : "Choose right play"}
          </Link>
        }
      />
      {alignment?.fallbackReason && (
        <div className="-mt-1 mb-2" role="status">
          <WarningLine>{alignment.fallbackReason}</WarningLine>
        </div>
      )}
      {leftId && rightId && leftId === rightId && (
        <StatusState kind="warning" title="Both sides show the same play">
          Choose a different right play to compare.
        </StatusState>
      )}

      <section
        aria-label="Comparison workspace"
        onKeyDown={onKeyDown}
        style={{ "--stage-chrome": "calc(var(--nav-h) + var(--heading-h) + var(--toolbar-h) + 72px + var(--dock-h))" } as CSSProperties}
      >
        <div className="flex h-10 items-center gap-2">
          <ViewMenu view={view} orientation="normalized" directionKnown onView={setView} onOrientation={() => {}} />
          <OverlayControl overlays={overlays} onChange={(p) => {
            const r = changeOverlay(overlays, p);
            setOverlays(r.next);
            if (r.announcement) announce(r.announcement);
          }} hasSelection={!!selected} />
          {single && (
            <div role="radiogroup" aria-label="Visible play" className="segmented">
              {(["left", "right"] as const).map((s) => (
                <button key={s} type="button" role="radio" aria-checked={mobileSide === s} onClick={() => setMobileSide(s)}>
                  {s === "left" ? "Left" : "Right"}
                </button>
              ))}
            </div>
          )}
          <FieldLegend items={tokenLegend(!ls || !rs || !!ls.ball || !!rs.ball)} className="ml-auto hidden flex-nowrap lg:flex" />
        </div>

        <div className={sidePane ? "grid gap-[var(--gap)]" : undefined} style={sidePane ? { gridTemplateColumns: "minmax(0,1fr) var(--analyst-w)" } : undefined}>
          <div className="min-w-0">
            <div
              className={single ? "" : stacked ? "grid gap-4" : "grid"}
              style={!single && !stacked ? { gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)", gap } : undefined}
            >
              {single ? fieldFor(mobileSide) : (
                <>
                  {fieldFor("left")}
                  {fieldFor("right")}
                </>
              )}
            </div>

            {selected && (
              <SelectionLine
                selected={selected}
                series={{ left: ls, right: rs }}
                counterpart={counterpart}
                picking={picking}
                onPick={() => setPicking(true)}
                onCancelPick={() => setPicking(false)}
                onClear={() => {
                  setSelected(null);
                  setPicking(false);
                }}
              />
            )}

            {linked && master && alignment && ls && rs ? (
              <CompareDock clock={master} alignment={alignment} left={ls} right={rs} onSyncChange={unlink} onLast={showLastObserved} />
            ) : !linked ? (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border py-2">
                <p className="text-caption text-fg-2">Sync is off: scrub each play with its own controls. Each keeps its own timestamps and frames.</p>
                <SyncSwitch on={false} onChange={relink} />
              </div>
            ) : rightId ? (
              <div className="h-24 border-t border-border">
                <p className="mt-3 text-caption text-muted">Synced playback starts when both plays have loaded.</p>
              </div>
            ) : null}
          </div>
          {sidePane && (
            <div className="relative min-h-0">
              <AnalystPane variant="slot" />
            </div>
          )}
        </div>
      </section>

      {analystOpen && !sidePane && <AnalystPane variant={single ? "sheet" : "inline"} className="mt-4" />}

      {rightId && leftId !== rightId && (
        <EvidencePanel
          result={cmp.data}
          error={cmp.error ? errorMessage(cmp.error) : null}
          unavailable={isUnavailable(cmp.error) || isRetrievalDown(cmp.error)}
          loading={cmp.isPending}
          onRetry={() => cmp.refetch()}
          onShowLast={ls && rs ? showLastObserved : null}
        />
      )}

      {ls && (
        <FrameDataTable series={ls} time={leftSource} orientation="normalized" selectedId={selected?.side === "left" ? selected.id : null} onSelect={(id) => onSelect("left", id)} title="Left frame data" />
      )}
      {rs && (
        <FrameDataTable series={rs} time={rightSource} orientation="normalized" selectedId={selected?.side === "right" ? selected.id : null} onSelect={(id) => onSelect("right", id)} title="Right frame data" />
      )}
    </div>
  );
}

const SPLIT_TEXT: Record<string, string> = { train: "train", validation: "validation", test: "held-out test" };

function PlayColumnHeader({ side, summary, playId, split }: { side: Side; summary: PlaySummary | null; playId: string; split: string | null }) {
  return (
    <div className="flex h-12 flex-col justify-center">
      <p className="eyebrow text-fg-2">
        {side === "left" ? "Left" : "Right"} · <span className="num font-normal tracking-normal normal-case">Play {playId}</span>
        {split && SPLIT_TEXT[split] && <span className="ml-2 font-normal tracking-normal normal-case text-muted">{SPLIT_TEXT[split]}</span>}
      </p>
      {summary ? (
        <p className="flex min-w-0 gap-3 text-body-2">
          <Link href={`/play/${encodeURIComponent(playId)}`} className="truncate font-medium text-fg hover:underline" aria-label={`Open play ${playId}: ${matchup(summary)}`}>
            {matchup(summary)}
          </Link>
          <span className="num shrink-0 text-meta text-fg-2">
            {[quarterClock(summary), downDistance(summary), codeLabel(summary.context.offense_formation)].filter(Boolean).join("  ")}
          </span>
        </p>
      ) : (
        <div className="skeleton mt-1 h-3 w-48" />
      )}
    </div>
  );
}

function SideFrameLine({ series, source, ended, lastFrameId }: { series: TrackingSeries; source: TimeSource; ended: boolean; lastFrameId: number | null }) {
  const i = useTimeDerived(source, (t) => frameIndexAt(series.times, t));
  const o = timeOrigin(series);
  const n = series.frameIds.length;
  return (
    <p className="num mt-1 text-meta text-fg-2" aria-live="off">
      Frame {series.frameIds[i]} <span className="font-sans text-caption text-muted">({i + 1} of {n})</span> · {elapsed(series.times[i] - o.time)}
      <span className="ml-1 font-sans text-caption text-muted">{o.kind === "snap" ? "from snap" : "from recording start"}</span>
      {lastFrameId !== null && series.frameIds[i] === lastFrameId && <span className="ml-2 font-sans text-caption text-fg">Last observed frame</span>}
      {ended && <span className="ml-2 font-sans text-caption text-fg">Ended</span>}
    </p>
  );
}

function ChooseRight({ leftId }: { leftId: string }) {
  const client = getClient();
  const sim = useQuery({ queryKey: ["similar", leftId, "approximate", {}], queryFn: ({ signal }) => client.findSimilar({ play_id: leftId, k: 5 }, signal), retry: false });
  return (
    <div className="min-w-0">
      <div className="flex h-12 flex-col justify-center">
        <p className="eyebrow text-fg-2">Right · no play chosen</p>
      </div>
      <div className="flex flex-col justify-center bg-surface p-6" style={{ minHeight: 300 }}>
        <h2 className="text-panel font-semibold">Choose a play to compare</h2>
        {sim.data && sim.data.results.length > 0 ? (
          <>
            <p className="mt-1 text-caption text-fg-2">
              Nearest by <span className="num">{sim.data.retrieval.model_version}</span> · cosine, not a probability
            </p>
            <ul className="mt-3">
              {sim.data.results.map((r) => (
                <li key={r.play_id} className="flex h-10 items-center gap-3 border-b border-border">
                  <span className="num w-6 text-meta text-fg">#{r.rank}</span>
                  <span className="min-w-0 flex-1 truncate text-body-2">{matchup(r.play)}</span>
                  <span className="num text-meta text-fg-2">{cosine(r.cosine_similarity)}</span>
                  <Link href={`/compare?left=${encodeURIComponent(leftId)}&right=${encodeURIComponent(r.play_id)}`} className="btn btn-quiet btn-sm">
                    Compare
                  </Link>
                </li>
              ))}
            </ul>
          </>
        ) : sim.isError ? (
          <p className="mt-1 text-body-2 text-fg-2">Similar plays are unavailable: {errorMessage(sim.error)}</p>
        ) : null}
        <Link href={`/explore?compare_left=${encodeURIComponent(leftId)}`} className="btn mt-4 self-start">
          Find a play in Explore
        </Link>
      </div>
    </div>
  );
}

function SelectionLine({
  selected,
  series,
  counterpart,
  picking,
  onPick,
  onCancelPick,
  onClear,
}: {
  selected: { side: Side; id: string };
  series: { left: TrackingSeries | null; right: TrackingSeries | null };
  counterpart: { id: string; method: string } | null;
  picking: boolean;
  onPick: () => void;
  onCancelPick: () => void;
  onClear: () => void;
}) {
  const other: Side = selected.side === "left" ? "right" : "left";
  const ref = (side: Side, id: string) => series[side]?.tracks.find((t) => t.ref.player_id === id)?.ref;
  const a = ref(selected.side, selected.id);
  const b = counterpart ? ref(other, counterpart.id) : null;
  return (
    <div className="flex min-h-10 flex-wrap items-center gap-x-4 gap-y-1 border-t border-border py-2 text-body-2">
      <span className="text-fg">
        {a ? `${playerLabel(a)} ${a.position ?? ""}` : selected.id} <span className="text-fg-2">({selected.side})</span>
      </span>
      {picking ? (
        <span className="text-accent">Select the counterpart on the {other} field · Escape to cancel</span>
      ) : b ? (
        <span className="text-fg-2">
          ↔ <span className="text-fg">{playerLabel(b)} {b.position}</span> ({other}) · {counterpart!.method}
        </span>
      ) : (
        <span className="text-fg-2">No computed counterpart. Choose one manually if useful.</span>
      )}
      <span className="ml-auto flex gap-1">
        {picking ? (
          <button type="button" className="btn btn-quiet btn-sm" onClick={onCancelPick}>
            Cancel
          </button>
        ) : (
          <button type="button" className="btn btn-quiet btn-sm" onClick={onPick}>
            Choose counterpart manually
          </button>
        )}
        <button type="button" className="btn btn-quiet btn-sm" onClick={onClear}>
          Clear selection
        </button>
      </span>
    </div>
  );
}

/** Sync toggle: a labelled switch, so state is not carried by color. */
function SyncSwitch({ on, onChange }: { on: boolean; onChange: () => void }) {
  return (
    <Tooltip content={on ? "Turn sync off to scrub each play on its own" : "Sync both plays to one clock again, from the left play's position"} describe={false}>
      <button type="button" role="switch" aria-checked={on} className="btn btn-control" data-active={on} onClick={onChange}>
        <span aria-hidden className={`inline-block h-3 w-6 rounded-full border border-control p-[1px] ${on ? "bg-selected" : ""}`}>
          <span className={`block h-full w-2.5 rounded-full ${on ? "translate-x-2.5 bg-accent" : "bg-control"}`} />
        </span>
        Sync {on ? "on" : "off"}
      </button>
    </Tooltip>
  );
}

function CompareDock({
  clock,
  alignment,
  left,
  right,
  onSyncChange,
  onLast,
}: {
  clock: Clock;
  alignment: Alignment;
  left: TrackingSeries;
  right: TrackingSeries;
  onSyncChange: () => void;
  onLast: () => void;
}) {
  const { playing, speed } = useClockState(clock);
  const li = useTimeDerived(clock, (tau) => sideFrameIndex(alignment, left, "left", tau, clock.getState().playing));
  const ri = useTimeDerived(clock, (tau) => sideFrameIndex(alignment, right, "right", tau, clock.getState().playing));
  const tau = useTimeDerived(clock, (t) => Math.round(t * 100) / 100);
  const lanes = useMemo(() => [mappedLane(left, "left", alignment.fromLeft), mappedLane(right, "right", alignment.fromRight)], [left, right, alignment]);
  const position = (t: number) => (alignment.progressAt ? percent(alignment.progressAt(t), 0) : elapsed(t));
  const valueText = (t: number) => {
    const a = sideFrameIndex(alignment, left, "left", t, false);
    const b = sideFrameIndex(alignment, right, "right", t, false);
    return `${position(t)}, ${alignment.label}. Left frame ${left.frameIds[a]} of ${left.frameIds.length}, right frame ${right.frameIds[b]} of ${right.frameIds.length}.`;
  };
  return (
    <div className="border-t border-border">
      <div className="flex min-h-10 flex-wrap items-center gap-1">
        <button type="button" className="btn btn-lg btn-icon" aria-label={playing ? "Pause both plays" : "Play both plays"} onClick={() => clock.toggle()}>
          {playing ? <Pause size={20} strokeWidth={1.5} aria-hidden /> : <Play size={20} strokeWidth={1.5} aria-hidden />}
        </button>
        <button type="button" className="btn btn-quiet btn-icon" aria-label="Previous frame" onClick={() => clock.step(-1)}>
          <ChevronLeft size={16} strokeWidth={1.5} aria-hidden />
        </button>
        <button type="button" className="btn btn-quiet btn-icon" aria-label="Next frame" onClick={() => clock.step(1)}>
          <ChevronRight size={16} strokeWidth={1.5} aria-hidden />
        </button>
        <button type="button" className="btn btn-quiet" aria-label="Reset both plays to the start" onClick={() => clock.seek(alignment.initial)}>
          <RotateCcw size={14} strokeWidth={1.5} aria-hidden />
          <span className="hidden sm:inline">Reset</span>
        </button>
        <button type="button" className="btn btn-quiet" aria-label="Show the last observed frame of both plays" onClick={onLast}>
          <SkipForward size={14} strokeWidth={1.5} aria-hidden />
          <span className="hidden sm:inline">Last observed</span>
        </button>
        <div role="radiogroup" aria-label="Playback speed" className="segmented ml-2 hidden md:inline-flex">
          {SPEEDS.map((sp) => (
            <button key={sp} type="button" role="radio" aria-checked={speed === sp} className="num" onClick={() => clock.setSpeed(sp)}>
              {sp}×
            </button>
          ))}
        </div>
        <p className="num ml-3 text-meta text-fg" aria-hidden>
          {position(tau)} <span className="font-sans text-caption text-muted">{alignment.label}</span>
        </p>
        <p className="num ml-3 hidden text-meta text-fg-2 lg:block" aria-hidden>
          L frame {left.frameIds[li]} · R frame {right.frameIds[ri]}
        </p>
        <span className="ml-auto">
          <SyncSwitch on onChange={onSyncChange} />
        </span>
      </div>
      <p className="mb-1 text-caption text-muted">{alignment.description}</p>
      <Timeline
        domain={alignment.domain}
        lanes={lanes}
        source={clock}
        label="Synced replay position"
        valueText={valueText}
        onSeek={(t) => clock.seek(t)}
        onKey={(e) => handleReplayKey(e, clock, { canPlay: true })}
      />
    </div>
  );
}

function evidenceValue(e: Evidence, side: "left" | "right"): string {
  const text = side === "left" ? e.left_text : e.right_text;
  const value = side === "left" ? e.left_value : e.right_value;
  if (text !== null) return codeLabel(text) ?? text;
  if (value === null) return "—";
  if (e.id.endsWith("metadata.down")) return downLabel(value);
  if (e.id.endsWith("metadata.quarter")) return value > 4 ? "OT" : `Q${value}`;
  return `${fixed(value, e.decimals)}${e.unit ? ` ${e.unit}` : ""}`;
}

function downLabel(v: number): string {
  return ["1st", "2nd", "3rd", "4th"][v - 1] ?? String(v);
}

function EvidencePanel({
  result,
  error,
  unavailable,
  loading,
  onRetry,
  onShowLast,
}: {
  result: CompareResponse | undefined;
  error: string | null;
  unavailable: boolean;
  loading: boolean;
  onRetry: () => void;
  onShowLast: (() => void) | null;
}) {
  const sim = result?.similarity ?? null;
  const context = result?.evidence.filter((e) => e.kind === "metadata") ?? [];
  const structure = result?.evidence.filter((e) => e.kind === "structural_metric") ?? [];
  return (
    <section aria-labelledby="evidence-heading" className="mt-6">
      <h2 id="evidence-heading" className="text-section font-semibold">
        What is similar, what differs
      </h2>
      {loading ? (
        <div className="skeleton mt-3 h-48 w-full" aria-label="Loading comparison evidence" />
      ) : error ? (
        <StatusState
          kind={unavailable ? "unavailable" : "error"}
          title="Comparison evidence unavailable"
          action={
            <button type="button" className="btn" onClick={onRetry}>
              Retry
            </button>
          }
        >
          {error} The replays above load independently of this panel.
        </StatusState>
      ) : result ? (
        <>
          <p className="mt-1 max-w-[820px] text-body-2 text-fg-2">
            {sim ? (
              <>
                The {sim.representation === "learned_embedding" ? "learned play embedding" : "baseline descriptor"} (
                <span className="num text-fg">{sim.model_version}</span>) ranks the right play{" "}
                <span className="text-fg">#{sim.right_rank_from_left}</span> nearest to the left play and the left play{" "}
                <span className="text-fg">#{sim.left_rank_from_right}</span> nearest to the right, among {sim.rank_pool.toLocaleString()} plays. Cosine similarity{" "}
                <span className="num text-fg">{cosine(sim.cosine_similarity)}</span>
                {sim.cosine_reference && (
                  <>
                    {" "}
                    (nearest neighbours in this space have median <span className="num">{cosine(sim.cosine_reference.nearest_neighbor_p50)}</span>, random pairs{" "}
                    <span className="num">{cosine(sim.cosine_reference.random_pair_p50)}</span>)
                  </>
                )}
                ; not a probability.
              </>
            ) : (
              <>Embedding similarity unavailable: {result.similarity_unavailable_reason} The evidence below does not need it.</>
            )}
          </p>

          <div className="mt-4 grid gap-6 lg:grid-cols-2">
            <div className="scroll-quiet overflow-x-auto" role="region" aria-label="Play context" tabIndex={0}>
              <p className="mb-2 text-caption text-muted">Context (pre-snap, and charted labels marked †)</p>
              <table className="data-table min-w-[420px]">
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Left</th>
                    <th scope="col">Right</th>
                    <th scope="col">Relation</th>
                  </tr>
                </thead>
                <tbody>
                  {context.map((e) => (
                    <tr key={e.id}>
                      <th scope="row" className="font-normal text-fg-2">
                        <Tooltip content={e.definition}>
                          <span tabIndex={0} className="cursor-help underline decoration-border decoration-dotted underline-offset-4">
                            {e.label}
                            {e.source === "charted_label" && "†"}
                          </span>
                        </Tooltip>
                      </th>
                      <td>{evidenceValue(e, "left")}</td>
                      <td>{evidenceValue(e, "right")}</td>
                      <td className={e.relation === "same" ? "text-fg" : "text-muted"}>
                        {e.relation === "same" ? "Same" : e.relation === "different" ? (e.delta !== null && e.unit ? `Differs (${signed(e.delta, e.decimals)} ${e.unit})` : "Differs") : "Not supplied"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="scroll-quiet overflow-x-auto" role="region" aria-label="Tracking measures" tabIndex={0}>
              <div className="mb-2 flex items-center justify-between gap-2">
                <p className="text-caption text-muted">Tracking measures at the last observed frame · delta = right − left</p>
                {onShowLast && (
                  <button type="button" className="btn btn-quiet btn-sm" onClick={onShowLast}>
                    Show that frame
                  </button>
                )}
              </div>
              <table className="data-table min-w-[420px]">
                <thead>
                  <tr>
                    <th scope="col">Measure</th>
                    <th scope="col" className="n">Left</th>
                    <th scope="col" className="n">Right</th>
                    <th scope="col" className="n">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {structure.map((e) => (
                    <tr key={e.id}>
                      <th scope="row" className="font-normal text-fg-2">
                        <Tooltip content={e.definition}>
                          <span tabIndex={0} className="cursor-help underline decoration-border decoration-dotted underline-offset-4">
                            {e.label}
                          </span>
                        </Tooltip>
                        {e.delta === null && e.missing_reason && <span className="block text-caption text-muted">{e.missing_reason}</span>}
                      </th>
                      <td className="n">{evidenceValue(e, "left")}</td>
                      <td className="n">{evidenceValue(e, "right")}</td>
                      <td className="n">{e.delta === null ? "—" : `${signed(e.delta, e.decimals)} ${e.unit ?? ""}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <p className="mt-3 max-w-[820px] text-caption text-muted">
            {result.evidence_note} Measures: {result.descriptor_version}, dataset <span className="num">{result.dataset_version}</span>.
            {result.correspondence && <> Player correspondence: {result.correspondence.method}</>}
          </p>
        </>
      ) : null}
    </section>
  );
}
