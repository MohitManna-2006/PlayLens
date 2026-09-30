"use client";

import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
import { StatusState } from "@/components/ui/StatusState";
import { cosine, ms } from "@/lib/format";
import { errorMessage, getClient } from "@/lib/datasource";

/**
 * Similar plays on request (§7). Scores are cosine values labeled with the
 * retrieval model, never percentages or probabilities (§13).
 */
export function SimilarPlays({ playId, unavailableReason }: { playId: string; unavailableReason: string | null }) {
  const client = getClient();
  const [requested, setRequested] = useState(false);
  const q = useQuery({
    queryKey: ["similar", playId],
    queryFn: ({ signal }) => client.findSimilar({ play_id: playId, k: 5 }, signal),
    enabled: requested && !unavailableReason,
    retry: false,
  });

  return (
    <section aria-labelledby="similar-heading" className="py-6">
      <div className="flex min-h-8 items-center justify-between gap-3">
        <h2 id="similar-heading" className="text-section font-semibold">
          Similar plays
        </h2>
        {!requested && !unavailableReason && (
          <button type="button" className="btn" onClick={() => setRequested(true)}>
            Find similar plays
          </button>
        )}
        {q.data && (
          <Link href={`/explore?similar_to=${encodeURIComponent(playId)}`} className="link-quiet text-body-2">
            View ranked list in Explore
          </Link>
        )}
      </div>

      {unavailableReason ? (
        <StatusState kind="unavailable" title="Similarity unavailable for this play">
          {unavailableReason}
        </StatusState>
      ) : !requested ? (
        <p className="mt-1 text-body-2 text-fg-2">Retrieval runs on request against the served retrieval model. Results name the model and scope.</p>
      ) : q.isPending ? (
        <ul aria-label="Loading similar plays" className="mt-2">
          {Array.from({ length: 5 }, (_, i) => (
            <li key={i} className="flex h-12 items-center gap-4 border-b border-border">
              <div className="skeleton h-3 w-4" />
              <div className="skeleton h-3 w-64" />
            </li>
          ))}
        </ul>
      ) : q.isError ? (
        <StatusState
          kind="error"
          title="Similarity search failed"
          action={
            <button type="button" className="btn" onClick={() => q.refetch()}>
              Retry search
            </button>
          }
        >
          {errorMessage(q.error)}
        </StatusState>
      ) : q.data.results.length === 0 ? (
        <StatusState kind="empty" title="No similar plays returned">
          The index returned no neighbours for this play.
        </StatusState>
      ) : (
        <>
          <p className="mt-1 text-caption text-fg-2">
            {q.data.scope.description} · model <span className="num text-fg">{q.data.model_version}</span> (
            {q.data.model_kind === "learned" ? "learned embedding" : q.data.model_kind === "baseline" ? "baseline, not a learned embedding" : "mock"}) ·
            self-match {q.data.scope.self_match_excluded ? "excluded" : "included"} · <span className="num">{ms(q.data.latency_ms)}</span> · cosine
            similarity, higher is more similar, not a probability
          </p>
          <ol className="mt-2">
            {q.data.results.map((r) => (
              <li key={r.play.play_id} className="flex h-12 items-center gap-4 border-b border-border">
                <span className="num w-4 text-meta text-muted">{r.rank}</span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-body-2 font-medium text-fg">
                    {r.play.away_team} at {r.play.home_team}
                    <span className="num ml-2 text-meta font-normal text-muted">{r.play.play_id}</span>
                  </p>
                  <p className="truncate text-caption text-fg-2">{r.play.description ?? "No supplied description"}</p>
                </div>
                <span className="num text-meta text-fg">Cosine {cosine(r.score)}</span>
                <Link href={`/play/${encodeURIComponent(r.play.play_id)}`} className="btn btn-quiet btn-sm">
                  Open
                </Link>
                <Link
                  href={`/compare?left=${encodeURIComponent(playId)}&right=${encodeURIComponent(r.play.play_id)}`}
                  className="btn btn-quiet btn-sm"
                >
                  Compare
                </Link>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  );
}
