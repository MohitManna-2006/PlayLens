"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Eye, GitCompareArrows } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { AnalystPane } from "@/components/analyst/AnalystPane";
import { useAnalystStore } from "@/components/shell/Providers";
import { SearchFilterBar } from "./SearchFilterBar";
import { PlayPreview } from "./PlayPreview";
import { MenuButton } from "@/components/ui/Menu";
import { StatusState } from "@/components/ui/StatusState";
import { Tooltip } from "@/components/ui/Tooltip";
import { useAnalystState } from "@/lib/analyst/store";
import type { PlayPage, PlayQuery, PlaySummary } from "@/lib/contracts";
import { errorMessage, getClient } from "@/lib/datasource";
import { parseQuery, toSearch } from "@/lib/explore/query";
import { cosine, downDistance, matchup, outcome, quarterClock } from "@/lib/format";
import { atLeast, useBreakpoint } from "@/lib/hooks/useBreakpoint";
import { readRecentRaw, parseRecent } from "@/lib/hooks/recent";

const SCROLL_KEY = "playlens:explore-scroll:";
const noopSubscribe = () => () => {};

export function ExploreScreen() {
  const sp = useSearchParams();
  const router = useRouter();
  const client = getClient();
  const bp = useBreakpoint();
  const analyst = useAnalystStore();
  const { open: analystOpen } = useAnalystState(analyst);
  const query = useMemo(() => parseQuery(new URLSearchParams(sp.toString())), [sp]);
  const compareLeft = sp.get("compare_left");
  const search = sp.toString();

  const plays = useQuery({
    queryKey: ["plays", query],
    queryFn: ({ signal }) => client.listPlays(query, signal),
    placeholderData: keepPreviousData,
  });
  const facets = useQuery({ queryKey: ["facets"], queryFn: ({ signal }) => client.getFacets(signal) });

  const [previewId, setPreviewId] = useState<string | null>(null);
  const recentRaw = useSyncExternalStore(noopSubscribe, readRecentRaw, () => "[]");
  const recent = useMemo(() => parseRecent(recentRaw), [recentRaw]);

  useEffect(() => analyst.bindWorkspace({ getContext: () => ({ kind: "explore" }), tools: { client } }), [analyst, client]);

  // Restore the list position when returning from Play (§6).
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !plays.data || plays.isPlaceholderData) return;
    restored.current = true;
    try {
      const y = window.sessionStorage.getItem(SCROLL_KEY + search);
      if (y !== null) {
        window.sessionStorage.removeItem(SCROLL_KEY + search);
        requestAnimationFrame(() => window.scrollTo(0, Number(y)));
      }
    } catch {
      /* storage unavailable */
    }
  }, [plays.data, plays.isPlaceholderData, search]);

  const rememberScroll = () => {
    try {
      window.sessionStorage.setItem(SCROLL_KEY + search, String(window.scrollY));
    } catch {
      /* storage unavailable */
    }
  };

  const navigate = (next: PlayQuery) => {
    router.replace(`/explore?${toSearch(next, { compare_left: compareLeft })}`, { scroll: false });
  };
  const update = (patch: Partial<PlayQuery>) => navigate({ ...query, ...patch, page: patch.page ?? 1 });
  const clearAll = () =>
    navigate({ sort: query.similar_to ? query.sort : "recent", similar_to: query.similar_to, page: 1, page_size: query.page_size });

  const compact = bp === "xs";
  const sidePreview = atLeast(bp, "2xl") && !analystOpen;
  const sideAnalyst = atLeast(bp, "xl") && analystOpen;
  const unfiltered = !query.q && !query.similar_to && query.page === 1 && Object.values({ ...query, sort: undefined, page: undefined, page_size: undefined }).every((v) => v === undefined);

  const compareHref = (id: string) =>
    compareLeft && compareLeft !== id
      ? `/compare?left=${encodeURIComponent(compareLeft)}&right=${encodeURIComponent(id)}`
      : `/compare?left=${encodeURIComponent(id)}`;

  const data = plays.data;
  const updating = plays.isFetching && plays.isPlaceholderData;
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;

  return (
    <div
      className={`mx-auto px-[var(--page-pad)] ${sideAnalyst ? "grid max-w-[calc(1280px+var(--analyst-w)+var(--gap)+2*var(--page-pad))] gap-[var(--gap)]" : "max-w-[calc(1280px+2*var(--page-pad))]"}`}
      style={sideAnalyst ? { gridTemplateColumns: "minmax(0,1fr) var(--analyst-w)" } : undefined}
    >
      <div className="min-w-0 pb-16">
        <header className="flex h-[72px] items-end pb-4">
          <h1 className="text-page font-semibold">Explore</h1>
        </header>

        <SearchFilterBar query={query} facets={facets.data} onChange={update} onClear={clearAll} compact={compact} />

        {analystOpen && !sideAnalyst && (
          <div className="mt-6">
            <AnalystPane variant={compact ? "sheet" : "inline"} />
          </div>
        )}

        {compareLeft && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2 border-l-2 border-accent bg-surface px-4 py-3">
            <p className="text-body-2 text-fg-2">
              Choose a play to compare with <span className="num text-fg">Play {compareLeft}</span>. Use Compare on any row.
            </p>
            <Link href={`/compare?left=${encodeURIComponent(compareLeft)}`} className="btn btn-quiet btn-sm">
              Cancel
            </Link>
          </div>
        )}

        {query.similar_to && data?.similarity && (
          <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
            <p className="text-body-2 text-fg-2">
              Sorted by similarity to <span className="num text-fg">Play {query.similar_to}</span> · retrieval model{" "}
              <span className="num text-fg">{data.similarity.model_version}</span> · cosine, not a probability
            </p>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => update({ similar_to: undefined, sort: "recent" })}>
              Clear similarity
            </button>
          </div>
        )}

        {unfiltered && recent.length > 0 && (
          <section aria-labelledby="recent-heading" className="mt-6">
            <h2 id="recent-heading" className="text-caption text-muted">
              Recent
            </h2>
            <ul className="mt-1">
              {recent.map((r) => (
                <li key={r.play_id} className="flex items-baseline gap-3 py-1">
                  <Link href={`/play/${encodeURIComponent(r.play_id)}`} onClick={rememberScroll} className="link-quiet text-body-2 text-fg">
                    {r.label}
                  </Link>
                  <span className="num truncate text-meta text-muted">{r.meta}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className={sidePreview && previewId ? "mt-6 grid gap-6" : "mt-6"} style={sidePreview && previewId ? { gridTemplateColumns: "minmax(0,1fr) 360px" } : undefined}>
          <div className="min-w-0">
            <ResultHeader
              data={data}
              updating={updating}
              loading={plays.isPending}
              query={query}
              onSort={(sort) => update({ sort })}
            />
            {plays.isError && !data ? (
              <StatusState
                kind="error"
                title="Search failed"
                action={
                  <button type="button" className="btn" onClick={() => plays.refetch()}>
                    Retry search
                  </button>
                }
              >
                {errorMessage(plays.error)} Your filters are unchanged.
              </StatusState>
            ) : (
              <PlayTable
                page={data}
                loading={plays.isPending}
                updating={updating}
                compact={compact}
                previewId={previewId}
                inlinePreview={!sidePreview}
                onPreview={(id) => setPreviewId((cur) => (cur === id ? null : id))}
                onClosePreview={() => setPreviewId(null)}
                onOpen={rememberScroll}
                compareHref={compareHref}
                onClear={clearAll}
              />
            )}
            {plays.isError && data && (
              <StatusState
                kind="error"
                title="Updating results failed"
                action={
                  <button type="button" className="btn" onClick={() => plays.refetch()}>
                    Retry search
                  </button>
                }
              >
                The rows above are from the previous search. {errorMessage(plays.error)}
              </StatusState>
            )}
            {data && data.total > 0 && (
              <nav aria-label="Pagination" className="mt-4 flex items-center justify-between">
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={query.page <= 1}
                  onClick={() => {
                    update({ page: query.page - 1 });
                    window.scrollTo(0, 0);
                  }}
                >
                  Previous
                </button>
                <p className="num text-meta text-fg-2" aria-live="polite">
                  Page {Math.min(query.page, totalPages)} of {totalPages}
                </p>
                <button
                  type="button"
                  className="btn btn-quiet"
                  disabled={query.page >= totalPages}
                  onClick={() => {
                    update({ page: query.page + 1 });
                    window.scrollTo(0, 0);
                  }}
                >
                  Next
                </button>
              </nav>
            )}
          </div>
          {sidePreview && previewId && (
            <PlayPreview playId={previewId} onClose={() => setPreviewId(null)} compareHref={compareHref(previewId)} variant="pane" />
          )}
        </div>
      </div>
      {sideAnalyst && (
        <div className="pt-4">
          <AnalystPane variant="side" />
        </div>
      )}
    </div>
  );
}

function ResultHeader({
  data,
  updating,
  loading,
  query,
  onSort,
}: {
  data: PlayPage | undefined;
  updating: boolean;
  loading: boolean;
  query: PlayQuery;
  onSort: (s: PlayQuery["sort"]) => void;
}) {
  const sortOptions = [
    { value: "recent", label: "Recent", hint: "Most recent game, then play order" },
    ...(query.similar_to ? [{ value: "similarity", label: "Similarity", hint: `Cosine similarity to play ${query.similar_to}` }] : []),
  ];
  return (
    <div className="flex h-10 items-center justify-between gap-3 border-b border-border">
      <p className="text-body-2 text-fg-2" aria-live="polite">
        {loading ? (
          "Loading results"
        ) : data ? (
          <>
            Results: <span className="num text-fg">{data.total}</span>
            {updating && <span className="ml-3 text-warning">Updating results</span>}
          </>
        ) : null}
      </p>
      <MenuButton
        label="Sort"
        triggerClassName="btn btn-quiet"
        triggerContent={<span>Sort: {query.sort === "similarity" ? "Similarity" : "Recent"}</span>}
        groups={[{ items: sortOptions.map((o) => ({ ...o, checked: query.sort === o.value })) }]}
        onSelect={(item) => onSort(item.value as PlayQuery["sort"])}
        placement="bottom-end"
        width={260}
      />
    </div>
  );
}

function PlayTable({
  page,
  loading,
  updating,
  compact,
  previewId,
  inlinePreview,
  onPreview,
  onClosePreview,
  onOpen,
  compareHref,
  onClear,
}: {
  page: PlayPage | undefined;
  loading: boolean;
  updating: boolean;
  compact: boolean;
  previewId: string | null;
  inlinePreview: boolean;
  onPreview: (id: string) => void;
  onClosePreview: () => void;
  onOpen: () => void;
  compareHref: (id: string) => string;
  onClear: () => void;
}) {
  if (!loading && page && page.total === 0) {
    if (page.dataset.play_count === 0) {
      return (
        <StatusState kind="empty" title="No tracking plays available">
          {page.dataset.dataset_version
            ? `Dataset ${page.dataset.dataset_version} has no ingested plays.`
            : "No dataset has been ingested yet. Run the ingestion pipeline to load tracking data."}
        </StatusState>
      );
    }
    return (
      <StatusState
        kind="empty"
        title="No plays match these filters"
        action={
          <button type="button" className="btn" onClick={onClear}>
            Clear filters
          </button>
        }
      >
        Broaden the search or remove a filter.
      </StatusState>
    );
  }

  const showScore = page?.sort === "similarity" && page.similarity;
  return (
    <table className="w-full table-fixed" aria-busy={loading || updating}>
      <caption className="sr-only">Plays{updating ? ", updating" : ""}</caption>
      <thead className="sr-only md:not-sr-only">
        <tr className="h-10 border-b border-border text-left text-caption text-muted">
          <th scope="col" className="px-3 pl-0 font-normal">
            Matchup / description
          </th>
          {!compact && (
            <th scope="col" className="w-28 px-3 font-normal">
              Q / clock
            </th>
          )}
          {!compact && (
            <th scope="col" className="w-28 px-3 font-normal">
              Down / dist
            </th>
          )}
          {!compact && (
            <th scope="col" className="w-24 px-3 text-right font-normal">
              {showScore ? "Cosine" : "Result"}
            </th>
          )}
          <th scope="col" className={compact ? "w-12 px-0" : "w-[88px] px-0"}>
            <span className="sr-only">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {loading || !page
          ? Array.from({ length: 6 }, (_, k) => (
              <tr key={k} className="h-14 border-b border-border" aria-hidden>
                <td className="py-3 pr-3">
                  <div className="skeleton h-3.5 w-48" />
                  <div className="skeleton mt-2 h-3 w-72 max-w-full" />
                </td>
                {!compact && (
                  <td className="px-3">
                    <div className="skeleton h-3 w-16" />
                  </td>
                )}
                {!compact && (
                  <td className="px-3">
                    <div className="skeleton h-3 w-14" />
                  </td>
                )}
                {!compact && (
                  <td className="px-3">
                    <div className="skeleton ml-auto h-3 w-10" />
                  </td>
                )}
                <td />
              </tr>
            ))
          : page.items.flatMap((p) => {
              const rows = [
                <PlayRow
                  key={p.play_id}
                  play={p}
                  stale={updating}
                  compact={compact}
                  previewing={previewId === p.play_id}
                  score={showScore ? (page.similarity?.scores[p.play_id] ?? null) : undefined}
                  onPreview={() => onPreview(p.play_id)}
                  onOpen={onOpen}
                  compareHref={compareHref(p.play_id)}
                />,
              ];
              if (inlinePreview && previewId === p.play_id) {
                rows.push(
                  <tr key={`${p.play_id}-preview`} className="border-b border-border">
                    <td colSpan={compact ? 2 : 5} className="p-0">
                      <PlayPreview playId={p.play_id} onClose={onClosePreview} compareHref={compareHref(p.play_id)} variant="inline" />
                    </td>
                  </tr>,
                );
              }
              return rows;
            })}
      </tbody>
    </table>
  );
}

function PlayRow({
  play,
  stale,
  compact,
  previewing,
  score,
  onPreview,
  onOpen,
  compareHref,
}: {
  play: PlaySummary;
  stale: boolean;
  compact: boolean;
  previewing: boolean;
  score: number | null | undefined;
  onPreview: () => void;
  onOpen: () => void;
  compareHref: string;
}) {
  const result = score !== undefined ? cosine(score) : outcome(play.outcome_yards);
  return (
    <tr
      className={`group relative h-14 border-b border-border transition-colors duration-[var(--dur-hover)] ${
        previewing ? "bg-selected" : "hover:bg-hover"
      } ${stale ? "text-muted" : ""}`}
    >
      <td className="relative py-3 pr-3">
        {previewing && <span aria-hidden className="absolute top-0 bottom-0 -left-[var(--page-pad)] w-0.5 bg-accent md:left-0 md:-ml-3" />}
        <Link
          href={`/play/${encodeURIComponent(play.play_id)}`}
          onClick={onOpen}
          className={`block truncate text-body-2 leading-4 font-medium hover:underline hover:underline-offset-4 ${stale ? "text-fg-2" : "text-fg"}`}
        >
          {matchup(play)}
        </Link>
        <p className="truncate text-caption leading-4 text-fg-2">
          {play.description ?? <span className="text-muted">No supplied description</span>}
        </p>
        {compact && (
          <p className="num mt-1 text-meta leading-4 text-fg-2">
            {[quarterClock(play), downDistance(play)].filter(Boolean).join("  ·  ") || "—"}
          </p>
        )}
      </td>
      {!compact && <td className="num px-3 text-meta text-fg-2">{quarterClock(play) ?? "—"}</td>}
      {!compact && <td className="num px-3 text-meta text-fg-2">{downDistance(play) ?? "—"}</td>}
      {!compact && (
        <td className="num px-3 text-right text-meta text-fg-2">
          {result ?? <span aria-label="Result unknown">—</span>}
        </td>
      )}
      {compact && (
        <td className="px-0 text-right">
          <button
            type="button"
            className="btn btn-quiet btn-icon"
            aria-label={`${previewing ? "Close preview of" : "Preview"} play ${play.play_id}`}
            aria-pressed={previewing}
            onClick={onPreview}
          >
            <Eye size={16} strokeWidth={1.5} aria-hidden />
          </button>
        </td>
      )}
      {!compact && (
        <td className="px-0">
          <div className="flex justify-end gap-1">
            <Tooltip content={previewing ? "Close preview" : "Preview snap frame"} describe={false}>
              <button
                type="button"
                className="btn btn-quiet btn-icon"
                aria-label={`${previewing ? "Close preview of" : "Preview"} play ${play.play_id}`}
                aria-pressed={previewing}
                onClick={onPreview}
              >
                <Eye size={16} strokeWidth={1.5} aria-hidden />
              </button>
            </Tooltip>
            <Tooltip content="Compare" describe={false}>
              <Link
                href={compareHref}
                aria-label={`Compare play ${play.play_id}`}
                className="btn btn-quiet btn-icon opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100"
              >
                <GitCompareArrows size={16} strokeWidth={1.5} aria-hidden />
              </Link>
            </Tooltip>
          </div>
        </td>
      )}
    </tr>
  );
}
