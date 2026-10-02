/**
 * Deterministic PlayLens tools used by the local Analyst transport. Each
 * returns evidence rows with explicit sources (tool, IDs, frame range,
 * definition) in the §27 envelope spirit; nothing here produces prose claims.
 */
import type { PlayLensClient } from "@/lib/datasource";
import { errorMessage } from "@/lib/datasource";
import { elapsed, playerLabel } from "@/lib/format";
import { DEFINITIONS, nearestOpponent, relativeSpeed, separationExtremes, separationSeries } from "@/lib/tracking/measures";
import type { TrackingSeries } from "@/lib/tracking/series";
import type { AnalystAction, AnalystBlock, EvidenceSource } from "./schema";

export const DATASET_VERSION_UNKNOWN = null;

export function describeFrame(series: TrackingSeries, index: number): string {
  const origin = series.snapIndex !== null ? series.times[series.snapIndex] : series.times[0];
  const t = series.times[index] - origin;
  return series.snapIndex !== null ? `${elapsed(t)} from snap` : `${elapsed(t)} from recording start`;
}

export function findEventFrame(series: TrackingSeries, word: string) {
  const kind = word === "snap" ? "snap" : word === "throw" ? "throw" : word === "arrival" ? "arrival" : word === "catch" ? "catch" : null;
  const e = kind ? series.events.find((ev) => ev.kind === kind) : series.events.find((ev) => ev.code === word);
  return e ?? null;
}

interface Evidence {
  sources: EvidenceSource[];
  blocks: AnalystBlock[];
  actions: AnalystAction[];
  notices: string[];
  error?: string;
}

export function separationEvidence(
  series: TrackingSeries,
  playId: string,
  playerId: string,
  frameId: number,
  datasetVersion: string | null,
): Evidence {
  const pi = series.tracks.findIndex((t) => t.ref.player_id === playerId);
  const fi = series.frameIds.indexOf(frameId);
  const first = series.frameIds[0];
  const last = series.frameIds[series.frameIds.length - 1];
  const sources: EvidenceSource[] = [
    {
      id: "s1",
      tool: "get_nearest_opponents",
      play_ids: [playId],
      player_ids: [playerId],
      frame_range: [frameId, frameId],
      definition: DEFINITIONS.separation,
      dataset_version: datasetVersion,
      model_version: null,
      request_id: null,
    },
    {
      id: "s2",
      tool: "get_player_state",
      play_ids: [playId],
      player_ids: [playerId],
      frame_range: [frameId, frameId],
      definition: DEFINITIONS.relativeSpeed,
      dataset_version: datasetVersion,
      model_version: null,
      request_id: null,
    },
    {
      id: "s3",
      tool: "get_separation_series",
      play_ids: [playId],
      player_ids: [playerId],
      frame_range: [first, last],
      definition: "Nearest-opponent distance at every tracked frame; frames where the player is not tracked are excluded.",
      dataset_version: datasetVersion,
      model_version: null,
      request_id: null,
    },
  ];
  if (pi < 0 || fi < 0) {
    return { sources: [], blocks: [], actions: [], notices: ["The selected player or frame is not in this play's tracking data."] };
  }
  const near = nearestOpponent(series, pi, fi);
  const rel = near ? relativeSpeed(series, pi, near.playerIndex, fi) : null;
  const series_ = separationSeries(series, pi);
  const from = series.snapIndex ?? 0;
  const ext = separationExtremes(series_, from);
  const oppLabel = near ? playerLabel(series.tracks[near.playerIndex].ref) : null;

  const blocks: AnalystBlock[] = [
    {
      type: "observed",
      title: `Frame ${frameId} · ${describeFrame(series, fi)}`,
      rows: [
        {
          ref: 1,
          label: oppLabel ? `Separation from ${oppLabel}` : "Separation",
          value: near?.distance ?? null,
          unit: "yd",
          decimals: 1,
          missing_reason: near ? null : "Player not tracked at this frame",
          frame_id: frameId,
          source_id: "s1",
        },
        {
          ref: 2,
          label: "Relative speed",
          value: rel,
          unit: "yd/s",
          decimals: 1,
          missing_reason: rel === null ? "Speed or direction not tracked" : null,
          frame_id: frameId,
          source_id: "s2",
        },
      ],
    },
    {
      type: "observed",
      title: series.snapIndex !== null ? `Snap to end · frames ${series.frameIds[from]}–${last}` : `Recording · frames ${first}–${last}`,
      rows: [
        {
          ref: 3,
          label: "Minimum separation",
          value: ext.min?.value ?? null,
          unit: "yd",
          decimals: 1,
          missing_reason: ext.min ? null : "No tracked frames",
          frame_id: ext.min ? series.frameIds[ext.min.index] : null,
          source_id: "s3",
        },
        {
          ref: 4,
          label: "Maximum separation",
          value: ext.max?.value ?? null,
          unit: "yd",
          decimals: 1,
          missing_reason: ext.max ? null : "No tracked frames",
          frame_id: ext.max ? series.frameIds[ext.max.index] : null,
          source_id: "s3",
        },
      ],
    },
  ];
  const actions: AnalystAction[] = [];
  if (ext.max) actions.push({ type: "jump_to_frame", play_id: playId, frame_id: series.frameIds[ext.max.index], label: `Jump to frame ${series.frameIds[ext.max.index]} · max separation` });
  if (ext.min) actions.push({ type: "jump_to_frame", play_id: playId, frame_id: series.frameIds[ext.min.index], label: `Jump to frame ${series.frameIds[ext.min.index]} · min separation` });
  actions.push({ type: "show_overlay", play_id: playId, overlay: "nearest_opponent", state: true, label: "Show nearest opponent" });
  return { sources, blocks, actions, notices: [] };
}

export async function similarEvidence(client: PlayLensClient, playId: string, signal: AbortSignal): Promise<Evidence> {
  try {
    const r = await client.findSimilar({ play_id: playId, k: 5 }, signal);
    const p = r.retrieval;
    const source: EvidenceSource = {
      id: "s1",
      tool: "find_similar_plays",
      play_ids: [playId, ...r.results.map((x) => x.play_id)],
      player_ids: [],
      frame_range: null,
      definition: `Cosine similarity between ${p.representation === "learned_embedding" ? "learned play embeddings" : "baseline play descriptors"} (${p.plan === "hnsw_index_scan" ? "HNSW index" : "exact scan"} over ${p.corpus_size} plays; self-match ${p.self_match_excluded ? "excluded" : "included"}). Not a probability.`,
      dataset_version: p.dataset_version,
      model_version: p.model_version,
      request_id: r.request_id,
    };
    const top = r.results[0];
    return {
      sources: [source],
      blocks: r.results.length
        ? [
            {
              type: "play_references",
              title: `Most similar plays · ${p.model_version}`,
              model_version: p.model_version,
              items: r.results.map((x) => ({
                play_id: x.play_id,
                label: `${x.play.away_team} at ${x.play.home_team}`,
                meta: x.play.description,
                score: x.cosine_similarity,
                source_id: "s1",
              })),
            },
          ]
        : [],
      actions: top
        ? [
            { type: "open_play", play_id: top.play_id, label: `Open play ${top.play_id}` },
            { type: "compare_plays", left_play_id: playId, right_play_id: top.play_id, label: `Compare with ${top.play_id}` },
          ]
        : [],
      notices: r.results.length ? [] : ["The retrieval index returned no results for this play."],
    };
  } catch (err) {
    return { sources: [], blocks: [], actions: [], notices: [], error: `Similarity search failed: ${errorMessage(err)}` };
  }
}

export async function compareEvidence(client: PlayLensClient, left: string, right: string, signal: AbortSignal): Promise<Evidence> {
  try {
    const r = await client.compare({ left_play_id: left, right_play_id: right }, signal);
    const sources: EvidenceSource[] = [
      {
        id: "s1",
        tool: "compare_plays",
        play_ids: [left, right],
        player_ids: [],
        frame_range: null,
        definition: `Deterministic evidence (${r.descriptor_version}): ${r.evidence_note}`,
        dataset_version: r.dataset_version,
        model_version: r.similarity?.model_version ?? null,
        request_id: r.request_id,
      },
    ];
    const metrics = r.evidence.filter((e) => e.kind === "structural_metric");
    const rows = (side: "left" | "right") =>
      metrics.map((m, i) => ({
        ref: i + 1,
        label: m.label,
        value: side === "left" ? m.left_value : m.right_value,
        unit: m.unit ?? "",
        decimals: m.decimals,
        missing_reason: (side === "left" ? m.left_value : m.right_value) === null ? (m.missing_reason ?? "Unavailable") : null,
        frame_id: m.frame_reference ? (side === "left" ? m.frame_reference.left_frame_ids : m.frame_reference.right_frame_ids).at(-1) ?? null : null,
        source_id: "s1",
      }));
    const notices: string[] = [];
    if (r.similarity) {
      notices.push(
        `Cosine similarity ${r.similarity.cosine_similarity.toFixed(3)} · ${r.similarity.model_version}; the right play ranks #${r.similarity.right_rank_from_left} among the left play's neighbours. Not a probability.`,
      );
    } else if (r.similarity_unavailable_reason) {
      notices.push(`Similarity unavailable: ${r.similarity_unavailable_reason}`);
    }
    return {
      sources,
      blocks: [
        { type: "observed", title: `Left · Play ${left}`, rows: rows("left") },
        { type: "observed", title: `Right · Play ${right}`, rows: rows("right") },
      ],
      actions: [],
      notices,
    };
  } catch (err) {
    return { sources: [], blocks: [], actions: [], notices: [], error: `Comparison failed: ${errorMessage(err)}` };
  }
}
