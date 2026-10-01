"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import type { PlayDetail } from "@/lib/contracts";
import { getClient } from "@/lib/datasource";
import { buildSeries, type TrackingSeries } from "@/lib/tracking/series";

/** Play detail + observed frames through the query cache, assembled into a TrackingSeries. */
export function usePlayData(playId: string | null) {
  const client = getClient();
  const detail = useQuery({
    queryKey: ["play", playId],
    queryFn: ({ signal }) => client.getPlay(playId!, signal),
    enabled: !!playId,
  });
  const frames = useQuery({
    queryKey: ["frames", playId],
    queryFn: ({ signal }) => client.getFrames(playId!, signal),
    enabled: !!playId,
  });
  const built = useMemo((): { series: TrackingSeries | null; error: string | null } => {
    if (!detail.data || !frames.data) return { series: null, error: null };
    try {
      return { series: buildSeries(detail.data, frames.data), error: null };
    } catch (e) {
      return { series: null, error: e instanceof Error ? e.message : "Tracking frames could not be assembled." };
    }
  }, [detail.data, frames.data]);
  return { detail, frames, series: built.series, seriesError: built.error };
}

/**
 * Held-out actual future trajectories. Fetched only when requested and only for
 * plays that report some, so observed replay never depends on future data.
 */
export function usePlayFuture(detail: PlayDetail | undefined, requested: boolean) {
  const client = getClient();
  const available = !!detail && detail.tracking.future_frame_count > 0 && detail.tracking.predicted_player_count > 0;
  return useQuery({
    queryKey: ["future", detail?.id],
    queryFn: ({ signal }) => client.getFuture(detail!.id, signal),
    enabled: requested && available,
    retry: false,
  });
}
