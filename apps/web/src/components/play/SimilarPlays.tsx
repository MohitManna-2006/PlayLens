"use client";

import { useQuery } from "@tanstack/react-query";
import { Check, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { StatusState, WarningLine } from "@/components/ui/StatusState";
import { Tooltip } from "@/components/ui/Tooltip";
import { ApiError, isRetrievalDown, type PlaySummary, type RetrievalMode, type SimilarityResult, type SimilaritySearchResponse } from "@/lib/contracts";
import { errorMessage, getClient } from "@/lib/datasource";
import { codeLabel, cosine, downDistance, fixed, matchup, ms, quarterClock } from "@/lib/format";
import { agreements, chips as chipsFor, metric, requestFilters, type ChipKey } from "@/lib/similar/filters";

export const SIMILAR_K = 10;

const SPLIT_LABEL: Record<SimilarityResult["split"], string> = {
  train: "Train",
  validation: "Validation",
  test: "Held-out test",
  unknown: "Split unknown",
};

/**
 * Similar plays (§7, F3). Real nearest neighbours from the API: cosine
 * similarity between learned play embeddings in PostgreSQL + pgvector, with
 * filters applied by the database. Rank and evidence lead; the cosine value is
 * secondary and never shown as a percentage or probability.
 */
export function SimilarPlays({ playId, query }: { playId: string; query: PlaySummary | null }) {
  const client = getClient();
  const [requested, setRequested] = useState(false);
  const [active, setActive] = useState<ReadonlySet<ChipKey>>(new Set());
  const [mode, setMode] = useState<RetrievalMode>("approximate");
  const chips = useMemo(() => (query ? chipsFor(query) : []), [query]);
  const filters = useMemo(() => requestFilters(chips, active), [chips, active]);
  const q = useQuery({
    queryKey: ["similar", playId, mode, filters],
    queryFn: ({ signal }) => client.findSimilar({ play_id: playId, k: SIMILAR_K, mode, filters }, signal),
    enabled: requested,
    retry: false,
  });

  const toggle = (key: ChipKey) =>
    setActive((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const clear = () => setActive(new Set());
  const retry = (
    <button type="button" className="btn" onClick={() => q.refetch()}>
      <RotateCcw size={14} strokeWidth={1.5} aria-hidden />
      Retry
    </button>
  );
  const missingEmbedding = q.error instanceof ApiError && q.error.code === "embedding_unavailable";

  return (
    <section aria-labelledby="similar-heading" className="py-6">
      <div className="flex min-h-8 flex-wrap items-center justify-between gap-3">
        <h2 id="similar-heading" className="text-section font-semibold">
          Similar plays
        </h2>
        {!requested && (
          <button type="button" className="btn" onClick={() => setRequested(true)}>
            Find similar plays
          </button>
        )}
        {requested && (
          <div role="radiogroup" aria-label="Retrieval mode" className="segmented">
            {(["approximate", "exact"] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)}>
                {m === "approximate" ? "HNSW index" : "Exact scan"}
              </button>
            ))}
          </div>
        )}
      </div>

      {!requested ? (
        <p className="mt-1 max-w-[720px] text-body-2 text-fg-2">
          Nearest plays by the model&apos;s learned play embedding, retrieved from the database. Results are ranked by cosine similarity, which is not a
          probability, and come with the metadata and tracking measures the plays share.
        </p>
      ) : (
        <>
          {chips.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
              <span className="text-caption text-muted">Filters</span>
              {chips.map((c) => {
                const on = active.has(c.key);
                return (
                  <button
                    key={c.key}
                    type="button"
                    className="btn btn-sm btn-control"
                    data-active={on}
                    aria-pressed={on}
                    disabled={!c.filters}
                    title={c.filters ? undefined : "Not supplied for this play"}
                    onClick={() => toggle(c.key)}
                  >
                    {on && <Check size={12} strokeWidth={2} aria-hidden />}
                    {c.label}
                  </button>
                );
              })}
              {active.size > 0 && (
                <button type="button" className="btn btn-quiet btn-sm" onClick={clear}>
                  Clear filters
                </button>
              )}
            </div>
          )}
          <div aria-live="polite" aria-busy={q.isFetching}>
            {q.isPending ? (
              <ol aria-label="Loading similar plays" className="mt-3">
                {Array.from({ length: 5 }, (_, i) => (
                  <li key={i} className="flex h-[60px] items-center gap-4 border-b border-border">
                    <div className="skeleton h-5 w-6" />
                    <div className="flex-1 space-y-2">
                      <div className="skeleton h-3 w-72 max-w-full" />
                      <div className="skeleton h-3 w-48 max-w-full" />
                    </div>
                  </li>
                ))}
              </ol>
            ) : q.isError && missingEmbedding ? (
              <StatusState kind="unavailable" title="No embedding for this play">
                {errorMessage(q.error)}
              </StatusState>
            ) : q.isError && isRetrievalDown(q.error) ? (
              <StatusState kind="unavailable" title="Similar-play retrieval is temporarily unavailable." action={retry}>
                {errorMessage(q.error)}
              </StatusState>
            ) : q.isError ? (
              <StatusState kind="error" title="Similarity search failed" action={retry}>
                {errorMessage(q.error)}
              </StatusState>
            ) : q.data.results.length === 0 ? (
              <StatusState
                kind="empty"
                title="No similar plays matched these filters."
                action={
                  active.size > 0 ? (
                    <button type="button" className="btn" onClick={clear}>
                      Clear filters
                    </button>
                  ) : undefined
                }
              >
                Try broadening the filters. {q.data.warnings.join(" ")}
              </StatusState>
            ) : (
              <Results data={q.data} playId={playId} />
            )}
          </div>
        </>
      )}
    </section>
  );
}

function Results({ data, playId }: { data: SimilaritySearchResponse; playId: string }) {
  const p = data.retrieval;
  const ref = p.cosine_reference;
  return (
    <>
      <p className="mt-2 text-caption text-fg-2">
        {p.representation === "learned_embedding" ? "Learned play embedding" : "Baseline descriptor (not a learned embedding)"}{" "}
        <span className="num text-fg">{p.model_version}</span> · {p.plan === "hnsw_index_scan" ? "HNSW index" : "exact scan"} over{" "}
        <span className="num">{p.candidates.toLocaleString()}</span> {p.candidates === p.corpus_size - 1 ? "plays" : "matching plays"} · query play excluded ·{" "}
        <span className="num">{ms(p.latency_ms)}</span>
      </p>
      {data.warnings.map((w) => (
        <div key={w} className="mt-1">
          <WarningLine>{w}</WarningLine>
        </div>
      ))}
      <ol className="mt-2" aria-label="Similar plays, ranked">
        {data.results.map((r) => (
          <ResultRow key={r.play_id} r={r} playId={playId} randomMedian={ref?.random_pair_p50 ?? null} />
        ))}
      </ol>
      <p className="mt-3 max-w-[820px] text-caption text-muted">
        Cosine similarity of the learned embeddings, not a probability or a percentage.
        {ref && (
          <>
            {" "}
            In this space random play pairs have median <span className="num">{cosine(ref.random_pair_p50)}</span> and a play&apos;s nearest neighbour median{" "}
            <span className="num">{cosine(ref.nearest_neighbor_p50)}</span>, so rank says more than the absolute value.
          </>
        )}{" "}
        {data.evidence_note} † Charted after the play.
      </p>
    </>
  );
}

function ResultRow({ r, playId, randomMedian }: { r: SimilarityResult; playId: string; randomMedian: number | null }) {
  // Under restrictive filters the nearest matching plays can be far away; say so
  // against the space's own measured reference rather than an invented cutoff.
  const belowRandom = randomMedian !== null && r.cosine_similarity < randomMedian;
  const p = r.play;
  const shared = agreements(r.evidence);
  const sep = metric(r.evidence, "target_separation");
  const width = metric(r.evidence, "offense_width");
  const context = [quarterClock(p), downDistance(p), codeLabel(p.context.offense_formation)].filter(Boolean).join(" · ");
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-border py-2.5">
      <span className="num w-8 shrink-0 text-section font-semibold text-fg" aria-label={`Rank ${r.rank}`}>
        #{r.rank}
      </span>
      <div className="min-w-0 flex-1 basis-[320px]">
        <p className="truncate text-body-2 font-medium text-fg">
          {matchup(p)}
          <span className="num ml-2 text-meta font-normal text-muted">{r.play_id}</span>
          <span className="ml-2 text-caption font-normal text-fg-2">{SPLIT_LABEL[r.split]}</span>
        </p>
        <p className="truncate text-caption text-fg-2">{context || "No supplied context"}</p>
        <p className="mt-0.5 flex flex-wrap gap-x-3 text-caption text-fg-2">
          {shared.length > 0 ? (
            shared.map((s) => (
              <Tooltip key={s.id} content={s.definition}>
                <span tabIndex={0} className="inline-flex items-center gap-1">
                  <Check size={12} strokeWidth={2} aria-hidden className="text-fg" />
                  {s.label}
                  {s.charted && "†"}
                </span>
              </Tooltip>
            ))
          ) : (
            <span className="text-muted">No shared down, distance, formation, or labels</span>
          )}
          {[sep, width].map(
            (m) =>
              m &&
              m.left_value !== null &&
              m.right_value !== null && (
                <Tooltip key={m.id} content={`${m.definition} This play → retrieved play.`}>
                  <span tabIndex={0} className="num text-meta">
                    {m.label === "Targeted receiver separation" ? "Target separation" : m.label} {fixed(m.left_value, 1)} → {fixed(m.right_value, 1)} {m.unit}
                  </span>
                </Tooltip>
              ),
          )}
        </p>
      </div>
      <span className="flex shrink-0 flex-col items-end">
        <span className="num text-meta text-fg-2" title="Cosine similarity, not a probability">
          cos {cosine(r.cosine_similarity)}
        </span>
        {belowRandom && <span className="text-caption text-muted">below the median random pair</span>}
      </span>
      <span className="flex shrink-0 gap-1">
        <Link href={`/play/${encodeURIComponent(r.play_id)}?similar_to=${encodeURIComponent(playId)}`} className="btn btn-quiet btn-sm">
          Open
        </Link>
        <Link href={`/compare?left=${encodeURIComponent(playId)}&right=${encodeURIComponent(r.play_id)}`} className="btn btn-sm">
          Compare
        </Link>
      </span>
    </li>
  );
}
