"use client";

import { useQuery } from "@tanstack/react-query";
import { ChevronLeft, ChevronRight, Link2, Link2Off, Pause, Play } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { AnalystPane } from "@/components/analyst/AnalystPane";
import { changeOverlay, FieldLegend, overlayLegend, OverlayControl, TOKEN_LEGEND, ViewMenu, type ViewMode } from "@/components/field/FieldControls";
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
import { align, phaseAvailable, type Alignment, type AlignMode } from "@/lib/compare/alignment";
import type { CompareResult, PlaySummary } from "@/lib/contracts";
import { errorMessage, getClient } from "@/lib/datasource";
import { cosine, downDistance, elapsed, fixed, matchup, playerLabel, quarterClock, signed } from "@/lib/format";
import { atLeast, useBreakpoint } from "@/lib/hooks/useBreakpoint";
import { usePlayData } from "@/lib/hooks/usePlayData";
import { Clock, SPEEDS, useClockState, useTimeDerived, type TimeSource } from "@/lib/replay/clock";
import { handleReplayKey } from "@/lib/replay/keys";
import { FULL_FIELD, unionExtent } from "@/lib/tracking/geometry";
import { actionExtent, frameIndexAt, type TrackingSeries } from "@/lib/tracking/series";

type Side = "left" | "right";

function mappedLane(series: TrackingSeries, id: Side, map: (t: number) => number): TimelineLane {
  const base = timelineLane(series, id, id === "left" ? "Left" : "Right");
  return {
    ...base,
    observed: [map(series.times[0]), map(series.times[series.times.length - 1])],
    gaps: series.gaps.map((g) => ({ from: map(g.startTime), to: map(g.endTime) })),
    events: series.events.map((e, k) => ({ ...base.events[k], time: map(e.time) })),
  };
}

function clampTime(series: TrackingSeries, t: number) {
  return Math.min(series.times[series.times.length - 1], Math.max(series.times[0], t));
}

export function CompareWorkspace() {
  const params = useSearchParams();
  const router = useRouter();
  const leftId = params.get("left");
  const rightId = params.get("right");
  const requested = (["snap", "start", "phase"].includes(params.get("align") ?? "") ? params.get("align") : "snap") as AlignMode;
  const client = getClient();
  const L = usePlayData(leftId);
  const R = usePlayData(rightId);
  const bp = useBreakpoint();
  const analyst = useAnalystStore();
  const { open: analystOpen } = useAnalystState(analyst);
  const { announce } = useAnnouncer();

  const cmp = useQuery({
    queryKey: ["compare", leftId, rightId],
    queryFn: ({ signal }) => client.compare(leftId!, rightId!, signal),
    enabled: !!leftId && !!rightId,
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

  const master = useMemo(
    () =>
      alignment
        ? new Clock({ start: alignment.domain[0], end: alignment.domain[1], stops: alignment.stops, initial: Math.max(alignment.domain[0], Math.min(0, alignment.domain[1])) })
        : null,
    [alignment],
  );
  useEffect(() => () => master?.dispose(), [master]);

  const [locals, setLocals] = useState<{ left: Clock; right: Clock } | null>(null);
  useEffect(() => () => {
    locals?.left.dispose();
    locals?.right.dispose();
  }, [locals]);

  const unlink = () => {
    if (!ls || !rs || !alignment || !master) return;
    master.pause();
    const tau = master.getTime();
    const mk = (s: TrackingSeries, t: number) =>
      new Clock({ start: s.times[0], end: s.times[s.times.length - 1], stops: s.times, gaps: s.gaps.map((g) => ({ from: g.startTime, to: g.endTime })), initial: clampTime(s, t) });
    setLocals({ left: mk(ls, alignment.toLeft(tau)), right: mk(rs, alignment.toRight(tau)) });
    setLinked(false);
    announce("Unlinked. Each play now has its own replay controls.");
  };
  const relink = () => {
    if (locals && alignment && master) master.seek(alignment.fromLeft(locals.left.getTime()));
    setLinked(true);
    setLocals(null);
    announce("Linked again using the left play's time.");
  };

  const idle: TimeSource = useMemo(() => ({ getTime: () => 0, subscribe: () => () => {} }), []);
  const leftSource: TimeSource = useMemo(() => {
    if (!linked && locals) return locals.left;
    if (!master || !alignment || !ls) return idle;
    return { getTime: () => clampTime(ls, alignment.toLeft(master.getTime())), subscribe: master.subscribe };
  }, [linked, locals, master, alignment, ls, idle]);
  const rightSource: TimeSource = useMemo(() => {
    if (!linked && locals) return locals.right;
    if (!master || !alignment || !rs) return idle;
    return { getTime: () => clampTime(rs, alignment.toRight(master.getTime())), subscribe: master.subscribe };
  }, [linked, locals, master, alignment, rs, idle]);

  const leftEnded = useTimeDerived(master ?? idle, (tau) => (linked && alignment && ls ? alignment.toLeft(tau) > ls.times[ls.times.length - 1] + 1e-6 : false));
  const rightEnded = useTimeDerived(master ?? idle, (tau) => (linked && alignment && rs ? alignment.toRight(tau) > rs.times[rs.times.length - 1] + 1e-6 : false));

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
  const live = useRef({ selected, label: alignment?.label ?? "Snap-relative" });
  useEffect(() => {
    live.current = { selected, label: alignment?.label ?? "Snap-relative" };
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
        <PlayColumnHeader side={side} summary={P.detail.data ?? null} playId={id} />
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
                {P.seriesError ?? errorMessage(err)} The other play remains inspectable; linked playback waits until both are valid.
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
        {s && <SideFrameLine series={s} source={source} ended={ended} />}
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
  return (
    <div ref={container} className="mx-auto max-w-[calc(1680px+2*var(--page-pad))] px-[var(--page-pad)] pb-16">
      <WorkspaceHeader
        crumbs={[{ label: `Play ${leftId}`, href: `/play/${encodeURIComponent(leftId)}` }, { label: "Compare" }]}
        title="Compare"
        subtitle={leftSummary ? `${matchup(leftSummary)}${R.detail.data ? ` vs ${matchup(R.detail.data)}` : ""}` : undefined}
        meta={[
          <span key="a" className="font-sans text-caption text-fg-2">
            Alignment:
          </span>,
          <MenuButton
            key="m"
            label="Alignment"
            triggerClassName="inline-flex h-[18px] items-center gap-1 rounded-control font-sans text-caption text-fg hover:underline"
            triggerContent={<span>{alignment?.label ?? "Snap-relative"}</span>}
            width={300}
            disabled={!alignment}
            groups={[
              {
                items: [
                  { value: "snap", label: "Snap-relative", hint: "Elapsed seconds from each play's snap", checked: alignment?.mode === "snap" },
                  { value: "start", label: "From recording start", hint: "Elapsed seconds from each recording's first frame", checked: alignment?.mode === "start" },
                  {
                    value: "phase",
                    label: "Phase aligned",
                    hint: ls && rs && phaseAvailable(ls, rs) ? "Maps snap, throw, and arrival; playback speeds differ" : "Needs snap, throw, and arrival events in both plays",
                    checked: alignment?.mode === "phase",
                    disabled: !(ls && rs && phaseAvailable(ls, rs)),
                  },
                ],
              },
            ]}
            onSelect={(i) => setAlign(i.value as AlignMode)}
          />,
          <span key="l" className="font-sans text-caption text-fg-2">
            {linked ? "Linked playback" : "Independent playback"}
          </span>,
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
          <FieldLegend items={TOKEN_LEGEND} className="ml-auto hidden flex-nowrap lg:flex" />
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
              <CompareDock
                clock={master}
                alignment={alignment}
                left={ls}
                right={rs}
                onUnlink={unlink}
              />
            ) : !linked ? (
              <div className="flex items-center justify-between border-t border-border py-2">
                <p className="text-caption text-fg-2">Independent seeking. Each play keeps its own timestamps and frames.</p>
                <button type="button" className="btn" onClick={relink}>
                  <Link2 size={14} strokeWidth={1.5} aria-hidden />
                  Relink
                </button>
              </div>
            ) : rightId ? (
              <div className="h-24 border-t border-border">
                <p className="mt-3 text-caption text-muted">Linked playback starts when both plays have loaded.</p>
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

      {rightId && <Differences result={cmp.data} error={cmp.error ? errorMessage(cmp.error) : null} loading={cmp.isPending} leftId={leftId} rightId={rightId} />}

      {ls && (
        <FrameDataTable series={ls} time={leftSource} orientation="normalized" selectedId={selected?.side === "left" ? selected.id : null} onSelect={(id) => onSelect("left", id)} title="Left frame data" />
      )}
      {rs && (
        <FrameDataTable series={rs} time={rightSource} orientation="normalized" selectedId={selected?.side === "right" ? selected.id : null} onSelect={(id) => onSelect("right", id)} title="Right frame data" />
      )}
    </div>
  );
}

function PlayColumnHeader({ side, summary, playId }: { side: Side; summary: PlaySummary | null; playId: string }) {
  return (
    <div className="flex h-12 flex-col justify-center">
      <p className="eyebrow text-fg-2">
        {side === "left" ? "Left" : "Right"} · <span className="num font-normal tracking-normal normal-case">Play {playId}</span>
      </p>
      {summary ? (
        <p className="flex min-w-0 gap-3 text-body-2">
          <Link href={`/play/${encodeURIComponent(playId)}`} className="truncate font-medium text-fg hover:underline">
            {matchup(summary)}
          </Link>
          <span className="num shrink-0 text-meta text-fg-2">{[quarterClock(summary), downDistance(summary)].filter(Boolean).join("  ")}</span>
        </p>
      ) : (
        <div className="skeleton mt-1 h-3 w-48" />
      )}
    </div>
  );
}

function SideFrameLine({ series, source, ended }: { series: TrackingSeries; source: TimeSource; ended: boolean }) {
  const i = useTimeDerived(source, (t) => frameIndexAt(series.times, t));
  const o = timeOrigin(series);
  return (
    <p className="num mt-1 text-meta text-fg-2">
      Frame {series.frameIds[i]} · {elapsed(series.times[i] - o.time)}
      <span className="ml-1 font-sans text-caption text-muted">{o.kind === "snap" ? "from snap" : "from recording start"}</span>
      {ended && <span className="ml-2 font-sans text-caption text-fg">Ended</span>}
    </p>
  );
}

function ChooseRight({ leftId }: { leftId: string }) {
  const client = getClient();
  const sim = useQuery({ queryKey: ["similar", leftId], queryFn: ({ signal }) => client.findSimilar({ play_id: leftId, k: 5 }, signal), retry: false });
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
              Nearest by <span className="num">{sim.data.model_version}</span> · cosine, not a probability
            </p>
            <ul className="mt-3">
              {sim.data.results.map((r) => (
                <li key={r.play.play_id} className="flex h-10 items-center gap-3 border-b border-border">
                  <span className="min-w-0 flex-1 truncate text-body-2">{matchup(r.play)}</span>
                  <span className="num text-meta text-fg-2">{cosine(r.score)}</span>
                  <Link href={`/compare?left=${encodeURIComponent(leftId)}&right=${encodeURIComponent(r.play.play_id)}`} className="btn btn-quiet btn-sm">
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

function CompareDock({ clock, alignment, left, right, onUnlink }: { clock: Clock; alignment: Alignment; left: TrackingSeries; right: TrackingSeries; onUnlink: () => void }) {
  const { playing, speed } = useClockState(clock);
  const li = useTimeDerived(clock, (tau) => frameIndexAt(left.times, clampTime(left, alignment.toLeft(tau))));
  const ri = useTimeDerived(clock, (tau) => frameIndexAt(right.times, clampTime(right, alignment.toRight(tau))));
  const tau = useTimeDerived(clock, (t) => Math.round(t * 10) / 10);
  const lanes = useMemo(() => [mappedLane(left, "left", alignment.fromLeft), mappedLane(right, "right", alignment.fromRight)], [left, right, alignment]);
  const valueText = (t: number) => {
    const a = frameIndexAt(left.times, clampTime(left, alignment.toLeft(t)));
    const b = frameIndexAt(right.times, clampTime(right, alignment.toRight(t)));
    return `${elapsed(t)} ${alignment.label}. Left frame ${left.frameIds[a]}, right frame ${right.frameIds[b]}.`;
  };
  return (
    <div className="h-24 border-t border-border">
      <div className="flex h-10 items-center gap-1">
        <button type="button" className="btn btn-lg btn-icon" aria-label={playing ? "Pause" : "Play"} onClick={() => clock.toggle()}>
          {playing ? <Pause size={20} strokeWidth={1.5} aria-hidden /> : <Play size={20} strokeWidth={1.5} aria-hidden />}
        </button>
        <button type="button" className="btn btn-quiet btn-icon" aria-label="Previous frame" onClick={() => clock.step(-1)}>
          <ChevronLeft size={16} strokeWidth={1.5} aria-hidden />
        </button>
        <button type="button" className="btn btn-quiet btn-icon" aria-label="Next frame" onClick={() => clock.step(1)}>
          <ChevronRight size={16} strokeWidth={1.5} aria-hidden />
        </button>
        <div role="radiogroup" aria-label="Playback speed" className="segmented ml-2 hidden md:inline-flex">
          {SPEEDS.map((s) => (
            <button key={s} type="button" role="radio" aria-checked={speed === s} className="num" onClick={() => clock.setSpeed(s)}>
              {s}×
            </button>
          ))}
        </div>
        <p className="num ml-3 text-meta text-fg" aria-hidden>
          {elapsed(tau)} <span className="font-sans text-caption text-muted">{alignment.label}</span>
        </p>
        <p className="num ml-3 hidden text-meta text-fg-2 lg:block" aria-hidden>
          L frame {left.frameIds[li]} · R frame {right.frameIds[ri]}
        </p>
        <Tooltip content="Seek each play independently" describe={false}>
          <button type="button" className="btn btn-quiet ml-auto" onClick={onUnlink}>
            <Link2Off size={14} strokeWidth={1.5} aria-hidden />
            Unlink
          </button>
        </Tooltip>
      </div>
      <Timeline
        domain={alignment.domain}
        lanes={lanes}
        source={clock}
        label="Linked replay position"
        valueText={valueText}
        onSeek={(t) => clock.seek(t)}
        onKey={(e) => handleReplayKey(e, clock, { canPlay: true })}
      />
    </div>
  );
}

function Differences({ result, error, loading, leftId, rightId }: { result: CompareResult | undefined; error: string | null; loading: boolean; leftId: string; rightId: string }) {
  return (
    <section aria-labelledby="diff-heading" className="mt-6">
      <p className="text-body-2 text-fg-2">
        {result?.similarity ? (
          <>
            Cosine similarity <span className="num text-fg">{cosine(result.similarity.score)}</span> · retrieval model{" "}
            <span className="num text-fg">{result.similarity.model_version}</span>
            {result.similarity.model_kind !== "learned" && " (baseline, not a learned embedding)"} · not a percentage or probability
          </>
        ) : result ? (
          <>Similarity unavailable: {result.similarity_unavailable_reason}</>
        ) : null}
      </p>
      <h2 id="diff-heading" className="mt-6 text-section font-semibold">
        Structural differences
      </h2>
      {loading ? (
        <div className="skeleton mt-3 h-40 w-full" aria-label="Loading measures" />
      ) : error ? (
        <StatusState kind="error" title="Measures unavailable">
          {error}
        </StatusState>
      ) : result ? (
        <>
          <p className="mt-1 text-caption text-fg-2">
            Window: {result.window} · {result.source} · delta = right − left
          </p>
          <div className="scroll-quiet mt-3 overflow-x-auto">
            <table className="data-table min-w-[560px]">
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col" className="n">Left · {leftId}</th>
                  <th scope="col" className="n">Right · {rightId}</th>
                  <th scope="col" className="n">Delta</th>
                </tr>
              </thead>
              <tbody>
                {result.measures.map((m) => {
                  const delta = m.left !== null && m.right !== null ? m.right - m.left : null;
                  return (
                    <tr key={m.key}>
                      <th scope="row" className="font-normal text-fg-2">
                        <Tooltip content={m.definition}>
                          <span tabIndex={0} className="cursor-help underline decoration-border decoration-dotted underline-offset-4">
                            {m.label}
                          </span>
                        </Tooltip>
                        {delta === null && m.missing_reason && <span className="block text-caption text-muted">{m.missing_reason}</span>}
                      </th>
                      <td className="n">{m.left === null ? "—" : `${fixed(m.left, m.decimals)} ${m.unit}`}</td>
                      <td className="n">{m.right === null ? "—" : `${fixed(m.right, m.decimals)} ${m.unit}`}</td>
                      <td className="n">{delta === null ? "—" : `${signed(delta, m.decimals)} ${m.unit}`}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {result.correspondence && <p className="mt-2 text-caption text-muted">Player correspondence: {result.correspondence.method}</p>}
        </>
      ) : null}
    </section>
  );
}
