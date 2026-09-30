/**
 * Analyst event and generative-UI schemas (Masterbrain §15, §27, C06–C07).
 * Every block and action is validated before it can mount; unknown types are
 * rejected and counted so the UI can say something was withheld.
 */
import { z } from "zod";

export const SourceSchema = z.object({
  id: z.string(),
  tool: z.string(),
  play_ids: z.array(z.string()),
  player_ids: z.array(z.string()),
  frame_range: z.tuple([z.number().int(), z.number().int()]).nullable(),
  definition: z.string(),
  dataset_version: z.string().nullable(),
  model_version: z.string().nullable(),
  request_id: z.string().nullable(),
});
export type EvidenceSource = z.infer<typeof SourceSchema>;

export const EvidenceRowSchema = z.object({
  ref: z.number().int().positive(),
  label: z.string(),
  value: z.number().nullable(),
  unit: z.string().nullable(),
  decimals: z.number().int().min(0).max(3),
  missing_reason: z.string().nullable(),
  frame_id: z.number().int().nullable(),
  source_id: z.string(),
});
export type EvidenceRow = z.infer<typeof EvidenceRowSchema>;

export const PlayRefItemSchema = z.object({
  play_id: z.string(),
  label: z.string(),
  meta: z.string().nullable(),
  score: z.number().nullable(),
  source_id: z.string(),
});

export const BlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("observed"), title: z.string(), rows: z.array(EvidenceRowSchema).min(1) }),
  z.object({
    type: z.literal("prediction"),
    model_version: z.string(),
    origin_frame_id: z.number().int(),
    horizon_s: z.number(),
    summary: z.string(),
    rows: z.array(EvidenceRowSchema),
  }),
  z.object({
    type: z.literal("counterfactual"),
    model_version: z.string(),
    summary: z.string(),
    rows: z.array(EvidenceRowSchema),
  }),
  z.object({
    type: z.literal("evaluation"),
    model_version: z.string(),
    run_id: z.string(),
    split: z.string(),
    rows: z.array(EvidenceRowSchema),
  }),
  z.object({
    type: z.literal("play_references"),
    title: z.string(),
    model_version: z.string().nullable(),
    items: z.array(PlayRefItemSchema).min(1),
  }),
]);
export type AnalystBlock = z.infer<typeof BlockSchema>;

export const OverlayKeySchema = z.enum(["trails", "velocity", "acceleration", "nearest_opponent", "interaction_graph"]);

export const ActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("jump_to_frame"), play_id: z.string(), frame_id: z.number().int(), label: z.string().optional() }),
  z.object({ type: z.literal("focus_player"), play_id: z.string(), player_id: z.string(), label: z.string().optional() }),
  z.object({
    type: z.literal("show_overlay"),
    play_id: z.string(),
    overlay: OverlayKeySchema,
    state: z.boolean(),
    label: z.string().optional(),
  }),
  z.object({ type: z.literal("open_play"), play_id: z.string(), label: z.string().optional() }),
  z.object({ type: z.literal("compare_plays"), left_play_id: z.string(), right_play_id: z.string(), label: z.string().optional() }),
  z.object({
    type: z.literal("apply_filters"),
    filters: z.record(z.string(), z.union([z.string(), z.number()])),
    label: z.string().optional(),
  }),
]);
export type AnalystAction = z.infer<typeof ActionSchema>;

export const AnalystEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("progress"), label: z.string() }),
  z.object({ type: z.literal("text"), delta: z.string() }),
  z.object({ type: z.literal("block"), block: z.unknown() }),
  z.object({ type: z.literal("source"), source: z.unknown() }),
  z.object({ type: z.literal("actions"), actions: z.array(z.unknown()) }),
  z.object({ type: z.literal("command"), action: z.unknown() }),
  z.object({ type: z.literal("notice"), text: z.string() }),
  z.object({ type: z.literal("done") }),
  z.object({ type: z.literal("error"), message: z.string(), retryable: z.boolean() }),
]);
export type AnalystEvent = z.infer<typeof AnalystEventSchema>;

export function actionLabel(a: AnalystAction): string {
  if (a.label) return a.label;
  switch (a.type) {
    case "jump_to_frame":
      return `Jump to frame ${a.frame_id}`;
    case "focus_player":
      return "Focus player";
    case "show_overlay":
      return `${a.state ? "Show" : "Hide"} ${a.overlay.replace(/_/g, " ")}`;
    case "open_play":
      return `Open play ${a.play_id}`;
    case "compare_plays":
      return "Compare plays";
    case "apply_filters":
      return "Apply filters";
  }
}
