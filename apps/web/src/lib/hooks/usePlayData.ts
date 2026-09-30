"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { getClient } from "@/lib/datasource";
import { buildSeries, type TrackingSeries } from "@/lib/tracking/series";

/** Play detail + frames through the query cache, assembled into a TrackingSeries. */
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
