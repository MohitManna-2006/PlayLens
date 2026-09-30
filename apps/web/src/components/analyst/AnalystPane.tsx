"use client";

import { ArrowDown, ChevronDown, ChevronRight, History, Info, RotateCcw, Square, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useAnalystStore } from "@/components/shell/Providers";
import { useAnnouncer } from "@/components/ui/Announcer";
import { MenuButton } from "@/components/ui/Menu";
import { StatusState, WarningLine } from "@/components/ui/StatusState";
import { actionLabel, type AnalystAction, type AnalystBlock, type EvidenceRow, type EvidenceSource } from "@/lib/analyst/schema";
import {
  contextDiffers,
  contextKey,
  contextLine,
  useAnalystContext,
  useAnalystState,
  type AnalystResponse,
  type AnalystStore,
} from "@/lib/analyst/store";
import { cosine, fixed } from "@/lib/format";

type Variant = "side" | "slot" | "inline" | "sheet";

/**
 * Analyst notebook (§9, §15): plain questions, evidence rows with category
 * rules, typed actions, and collapsed sources. Nonmodal beside the workspace;
 * a modal sheet only below 768 px.
 */
export function AnalystPane({ variant, className = "" }: { variant: Variant; className?: string }) {
  const store = useAnalystStore();
  const state = useAnalystState(store);
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (variant !== "sheet") return;
    const d = dialog.current;
    if (state.open && d && !d.open) d.showModal();
  }, [variant, state.open]);

  if (!state.open) return null;

  if (variant === "sheet") {
    return (
      <dialog
        ref={dialog}
        aria-label="Analyst"
        className="m-0 h-dvh max-h-none w-screen max-w-none bg-bg p-0 text-fg"
        onCancel={(e) => {
          e.preventDefault();
          store.setOpen(false);
        }}
      >
        <PaneBody store={store} variant={variant} />
      </dialog>
    );
  }

  return (
    <aside
      id="analyst-pane"
      aria-label="Analyst"
      className={`flex min-h-0 flex-col bg-bg motion-safe:animate-[pane-in_var(--dur-pane)_var(--ease-out)] ${
        variant === "side"
          ? "sticky top-[calc(var(--nav-h)+16px)] h-[calc(100dvh-var(--nav-h)-32px)] border-l border-border"
          : variant === "slot"
            ? "absolute inset-0 border-l border-border"
            : "h-[320px] min-h-[240px] resize-y overflow-hidden border-y border-border"
      } ${className}`}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !e.defaultPrevented) {
          e.preventDefault();
          store.setOpen(false);
        }
      }}
    >
      <PaneBody store={store} variant={variant} />
    </aside>
  );
}

function PaneBody({ store, variant }: { store: AnalystStore; variant: Variant }) {
  const state = useAnalystState(store);
  const ctx = useAnalystContext(store);
  const key = contextKey(ctx);
  const transcript = state.transcripts[key] ?? [];
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [seenVersion, setSeenVersion] = useState(state.version);
  const newBelow = !atBottom && state.version > seenVersion;
  const { announce } = useAnnouncer();
  const last = transcript[transcript.length - 1];
  const lastStatus = last?.status;

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom) el.scrollTop = el.scrollHeight;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.version]);

  useEffect(() => {
    if (!last) return;
    if (lastStatus === "complete") {
      const n = last.blocks.reduce((a, b) => a + ("rows" in b ? b.rows.length : b.items.length), 0);
      announce(`Analyst response complete${n ? `, ${n} evidence item${n === 1 ? "" : "s"}` : ""}.`);
    } else if (lastStatus === "failed") {
      announce("Analyst request failed.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastStatus, last?.id]);

  const service = state.service;
  const unavailable = service.status === "unavailable";
  const suggestions = unavailable ? [] : store.suggestionsFor(ctx);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="shrink-0 border-b border-border px-4">
        <div className="flex h-12 items-center justify-between gap-2">
          <h2 className="text-panel font-semibold">Analyst</h2>
          <button type="button" className="btn btn-quiet" onClick={() => store.setOpen(false)}>
            {variant === "sheet" ? (
              ctx.kind === "play" ? "Return to play" : ctx.kind === "compare" ? "Return to comparison" : ctx.kind === "playlab" ? "Return to PlayLab" : "Close"
            ) : (
              <X size={16} strokeWidth={1.5} aria-hidden />
            )}
            {variant !== "sheet" && <span>Close</span>}
          </button>
        </div>
        <p className="num -mt-1 truncate pb-2 text-meta text-fg-2" title={contextLine(ctx)}>
          {contextLine(ctx)}
        </p>
        {service.note && service.status !== "unavailable" && (
          <p className="flex items-start gap-1.5 pb-2 text-caption text-muted">
            <Info size={12} strokeWidth={1.5} aria-hidden className="mt-[3px] shrink-0" />
            <span>{service.mode === "tools" ? "Language model not connected · tool results only" : service.note}</span>
          </p>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        className="scroll-quiet relative min-h-0 flex-1 overflow-y-auto px-4 py-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 24;
          setAtBottom(bottom);
          if (bottom) setSeenVersion(state.version);
        }}
      >
        {unavailable && (
          <StatusState kind="unavailable" title="Analyst unavailable" compact className="mb-6">
            {service.note} Earlier responses remain below.
          </StatusState>
        )}
        {transcript.length === 0 && !unavailable && (
          <div className="text-body-2 text-fg-2">
            {service.mode === "tools" && service.note && <p className="mb-3">{service.note}</p>}
            {suggestions.length > 0 ? (
              <ul className="space-y-2">
                {suggestions.map((s) => (
                  <li key={s}>
                    <button type="button" className="link text-left text-body-2" onClick={() => store.submit(s)}>
                      {s}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">
                {ctx.kind === "explore" ? "Open a play to ask about players, frames, and similar plays." : "No tool requests are available for this view."}
              </p>
            )}
          </div>
        )}
        <ol className="space-y-6">
          {transcript.map((r) => (
            <li key={r.id}>
              <ResponseView response={r} store={store} current={ctx} />
            </li>
          ))}
        </ol>
      </div>
        {newBelow && (
          <button
            type="button"
            className="btn btn-sm absolute right-4 bottom-3 z-10 shadow-float"
            onClick={() => {
              const el = scroller.current;
              if (el) el.scrollTop = el.scrollHeight;
              setSeenVersion(state.version);
            }}
          >
            <ArrowDown size={14} strokeWidth={1.5} aria-hidden />
            New response below
          </button>
        )}
      </div>

      <Composer store={store} disabledReason={unavailable ? "The Analyst service is unavailable." : null} contextText={contextLine(ctx)} />
    </div>
  );
}

function Composer({ store, disabledReason, contextText }: { store: AnalystStore; disabledReason: string | null; contextText: string }) {
  const [text, setText] = useState("");
  const area = useRef<HTMLTextAreaElement>(null);
  useAnalystState(store);
  const busy = store.busy;

  useEffect(() => {
    area.current?.focus({ preventScroll: true });
  }, []);

  const resize = () => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(144, Math.max(80, el.scrollHeight))}px`;
  };

  const send = () => {
    if (!text.trim() || disabledReason) return;
    store.submit(text);
    setText("");
    requestAnimationFrame(resize);
  };

  return (
    <form
      className="shrink-0 border-t border-border px-4 pt-3 pb-4"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <label htmlFor="analyst-input" className="sr-only">
        Ask the Analyst
      </label>
      <textarea
        id="analyst-input"
        ref={area}
        rows={3}
        value={text}
        disabled={!!disabledReason}
        placeholder="Ask about this play…"
        onChange={(e) => {
          setText(e.target.value);
          resize();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            send();
          }
        }}
        className="input scroll-quiet block h-20 max-h-36 min-h-20 resize-none py-2"
      />
      <div className="mt-2 flex items-center justify-between gap-3">
        <p className="num min-w-0 truncate text-caption text-muted" title={contextText}>
          {disabledReason ?? `Context: ${contextText}`}
        </p>
        {busy ? (
          <button type="button" className="btn" onClick={() => store.stop()}>
            <Square size={12} strokeWidth={1.5} aria-hidden />
            Stop
          </button>
        ) : (
          <button type="submit" className="btn btn-primary" disabled={!text.trim() || !!disabledReason}>
            Send
          </button>
        )}
      </div>
    </form>
  );
}

/* ------------------------------------------------------------------ */

const MAX_VISIBLE_ROWS = 4;

function ResponseView({ response: r, store, current }: { response: AnalystResponse; store: AnalystStore; current: ReturnType<typeof useAnalystContext> }) {
  const [showAll, setShowAll] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const differs = contextDiffers(r.context, current);
  const sizes = r.blocks.map((b) => ("rows" in b ? b.rows.length : b.items.length));
  const totalRows = sizes.reduce((a, b) => a + b, 0);
  const budgets = sizes.map((_, i) => (showAll ? Infinity : MAX_VISIBLE_ROWS - sizes.slice(0, i).reduce((a, b) => a + b, 0)));
  const sourceIndex = new Map(r.sources.map((s, i) => [s.id, i + 1]));

  const runAction = (a: AnalystAction) => {
    const outcome = store.runAction(a, r.context);
    store.acknowledge(r, outcome.message);
  };

  return (
    <article aria-label={`Response to: ${r.question}`} className="text-body">
      <p className="text-body font-medium text-fg">{r.question}</p>
      {differs && (
        <p className="mt-1 flex items-center gap-1.5 text-caption text-muted">
          <History size={12} strokeWidth={1.5} aria-hidden />
          <span className="num">Asked at {contextLine(r.context)}</span>
        </p>
      )}

      {r.status === "in_progress" && (
        <p className="mt-2 text-caption text-muted" role="status">
          In progress{r.progress ? ` · ${r.progress}` : ""}
        </p>
      )}

      {r.command && (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-body-2 text-fg-2">
          <span>{r.command.undone ? "View change undone." : r.command.message}</span>
          {r.command.undo && !r.command.undone && (
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => store.undoCommand(r)}>
              <RotateCcw size={12} strokeWidth={1.5} aria-hidden />
              Undo view change
            </button>
          )}
        </div>
      )}

      {r.interpretation && (
        <section className="mt-3">
          <h3 className="eyebrow text-fg-2">AI interpretation</h3>
          <p className={`mt-1 whitespace-pre-wrap text-body ${r.status === "in_progress" ? "text-fg-2" : "text-fg"}`}>{r.interpretation}</p>
        </section>
      )}

      {r.notices.map((n, i) => (
        <p key={i} className="mt-3 flex items-start gap-2 text-body-2 text-fg-2">
          <Info size={14} strokeWidth={1.5} aria-hidden className="mt-[3px] shrink-0 text-muted" />
          <span>{n}</span>
        </p>
      ))}

      {r.blocks.map((b, i) => (
        <BlockView key={i} block={b} budget={budgets[i]} sourceIndex={sourceIndex} />
      ))}

      {totalRows > MAX_VISIBLE_ROWS && (
        <button type="button" className="link mt-2 text-body-2" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all evidence (${totalRows})`}
        </button>
      )}

      {r.rejected > 0 && (
        <div className="mt-3">
          <WarningLine>
            {r.rejected} evidence item{r.rejected === 1 ? "" : "s"} failed validation and {r.rejected === 1 ? "was" : "were"} withheld.
          </WarningLine>
        </div>
      )}

      {r.actions.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {r.actions.slice(0, 3).map((a, i) => (
            <button key={i} type="button" className="btn btn-sm" onClick={() => runAction(a)}>
              {actionLabel(a)}
            </button>
          ))}
          {r.actions.length > 3 && (
            <MenuButton
              label="More actions"
              triggerClassName="btn btn-quiet btn-sm"
              triggerContent="More actions"
              groups={[{ items: r.actions.slice(3).map((a, i) => ({ value: String(i + 3), label: actionLabel(a), kind: "action" as const })) }]}
              onSelect={(item) => runAction(r.actions[Number(item.value)])}
            />
          )}
        </div>
      )}
      {r.acknowledgement && <p className="mt-2 text-caption text-fg-2" role="status">{r.acknowledgement}</p>}

      {r.sources.length > 0 && (
        <div className="mt-3">
          <button
            type="button"
            className="flex items-center gap-1 text-caption text-fg-2 hover:text-fg"
            aria-expanded={sourcesOpen}
            onClick={() => setSourcesOpen((v) => !v)}
          >
            {sourcesOpen ? <ChevronDown size={14} strokeWidth={1.5} aria-hidden /> : <ChevronRight size={14} strokeWidth={1.5} aria-hidden />}
            Sources ({r.sources.length})
          </button>
          {sourcesOpen && (
            <ol className="mt-2 space-y-3">
              {r.sources.map((s, i) => (
                <li key={s.id}>
                  <ProvenanceDetails source={s} index={i + 1} />
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {r.status === "stopped" && <p className="mt-2 text-caption text-muted">Stopped. Content above is partial.</p>}
      {r.status === "failed" && r.error && (
        <div className="mt-3">
          <StatusState
            kind="error"
            compact
            title="The request did not complete"
            action={
              r.error.retryable ? (
                <button type="button" className="btn btn-sm" onClick={() => store.retry(r)}>
                  Retry
                </button>
              ) : undefined
            }
          >
            {r.error.message}
          </StatusState>
        </div>
      )}
    </article>
  );
}

function CategoryRule({ kind, children }: { kind: "observed" | "prediction" | "counterfactual" | "evaluation"; children: ReactNode }) {
  const rule =
    kind === "observed"
      ? "border-l-2 border-control"
      : kind === "prediction" || kind === "counterfactual"
        ? "border-l-2 border-dashed border-accent"
        : "border-l-2 border-fg-2";
  return <section className={`mt-3 pl-3 ${rule}`}>{children}</section>;
}

function DashSample() {
  return (
    <svg width="20" height="6" aria-hidden className="inline-block align-middle">
      <line x1="0" y1="3" x2="20" y2="3" stroke="#E7B66B" strokeWidth="2" strokeDasharray="6 4" />
    </svg>
  );
}

function Rows({ rows, budget, sourceIndex }: { rows: EvidenceRow[]; budget: number; sourceIndex: Map<string, number> }) {
  const visible = rows.slice(0, Math.max(0, budget));
  if (!visible.length) return null;
  return (
    <dl className="mt-1">
      {visible.map((row) => (
        <div key={row.ref} className="flex items-baseline gap-3 py-1">
          <dt className="min-w-0 flex-1 text-body-2 text-fg-2">
            {row.label}
            {row.frame_id !== null && <span className="num ml-2 text-meta text-muted">frame {row.frame_id}</span>}
          </dt>
          <dd className="num text-right text-meta">
            {row.value === null ? (
              <span className="text-muted" title={row.missing_reason ?? undefined}>
                — <span className="font-sans text-caption">{row.missing_reason}</span>
              </span>
            ) : (
              <span className="text-fg">
                {fixed(row.value, row.decimals)}
                {row.unit && <span className="ml-1 text-fg-2">{row.unit}</span>}
              </span>
            )}
          </dd>
          <span className="num w-6 text-right text-meta text-muted" aria-label={`Source ${sourceIndex.get(row.source_id) ?? "?"}`}>
            [{sourceIndex.get(row.source_id) ?? "?"}]
          </span>
        </div>
      ))}
    </dl>
  );
}

function BlockView({ block: b, budget, sourceIndex }: { block: AnalystBlock; budget: number; sourceIndex: Map<string, number> }) {
  const size = "rows" in b ? b.rows.length : b.items.length;
  if (budget <= 0 && size > 0) return null;
  switch (b.type) {
    case "observed":
      return (
        <CategoryRule kind="observed">
          <h3 className="eyebrow text-fg-2">
            Observed data <span className="num font-normal tracking-normal normal-case">· {b.title}</span>
          </h3>
          <Rows rows={b.rows} budget={budget} sourceIndex={sourceIndex} />
        </CategoryRule>
      );
    case "prediction":
      return (
        <CategoryRule kind="prediction">
          <h3 className="eyebrow flex items-center gap-2 text-fg-2">
            <DashSample /> Model prediction <span className="num font-normal tracking-normal normal-case">· {b.model_version}</span>
          </h3>
          <p className="mt-1 text-body-2 text-fg-2">
            {b.summary} <span className="num text-meta">Origin frame {b.origin_frame_id} · horizon {fixed(b.horizon_s, 1)} s</span>
          </p>
          <Rows rows={b.rows} budget={budget} sourceIndex={sourceIndex} />
        </CategoryRule>
      );
    case "counterfactual":
      return (
        <CategoryRule kind="counterfactual">
          <h3 className="eyebrow flex items-center gap-2 text-fg-2">
            <DashSample /> Modified input <span className="num font-normal tracking-normal normal-case">· {b.model_version}</span>
          </h3>
          <p className="mt-1 text-body-2 font-medium text-fg">Model counterfactual, not causal inference.</p>
          <p className="text-body-2 text-fg-2">{b.summary}</p>
          <Rows rows={b.rows} budget={budget} sourceIndex={sourceIndex} />
        </CategoryRule>
      );
    case "evaluation":
      return (
        <CategoryRule kind="evaluation">
          <h3 className="eyebrow text-fg-2">
            Evaluation result <span className="num font-normal tracking-normal normal-case">· {b.model_version} · run {b.run_id} · {b.split}</span>
          </h3>
          <Rows rows={b.rows} budget={budget} sourceIndex={sourceIndex} />
        </CategoryRule>
      );
    case "play_references":
      return (
        <section className="mt-3">
          <h3 className="eyebrow text-fg-2">
            Retrieved plays{b.model_version && <span className="num font-normal tracking-normal normal-case"> · {b.model_version}</span>}
          </h3>
          <ul className="mt-1">
            {b.items.slice(0, Math.max(0, budget)).map((item) => (
              <li key={item.play_id} className="flex items-baseline gap-3 border-b border-border py-2 last:border-0">
                <div className="min-w-0 flex-1">
                  <Link href={`/play/${encodeURIComponent(item.play_id)}`} className="block truncate text-body-2 font-medium text-fg hover:underline">
                    {item.label}
                  </Link>
                  {item.meta && <p className="truncate text-caption text-fg-2">{item.meta}</p>}
                </div>
                {item.score !== null && <span className="num text-meta text-fg">Cosine {cosine(item.score)}</span>}
                <span className="num w-6 text-right text-meta text-muted">[{sourceIndex.get(item.source_id) ?? "?"}]</span>
              </li>
            ))}
          </ul>
        </section>
      );
  }
}

export function ProvenanceDetails({ source: s, index }: { source: EvidenceSource; index?: number }) {
  const rows: Array<[string, string | null]> = [
    ["Tool", s.tool],
    ["Plays", s.play_ids.join(", ") || null],
    ["Players", s.player_ids.join(", ") || null],
    ["Frames", s.frame_range ? (s.frame_range[0] === s.frame_range[1] ? String(s.frame_range[0]) : `${s.frame_range[0]}–${s.frame_range[1]}`) : null],
    ["Dataset", s.dataset_version],
    ["Model", s.model_version],
    ["Request", s.request_id],
  ];
  return (
    <div className="text-caption">
      <p className="text-fg-2">
        {index !== undefined && <span className="num mr-2 text-muted">[{index}]</span>}
        {s.definition}
      </p>
      <dl className="mt-1 grid grid-cols-[72px_minmax(0,1fr)] gap-x-2">
        {rows
          .filter(([, v]) => v)
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-muted">{k}</dt>
              <dd className="num truncate text-meta text-fg-2" title={v ?? undefined}>
                {v}
              </dd>
            </div>
          ))}
      </dl>
    </div>
  );
}
