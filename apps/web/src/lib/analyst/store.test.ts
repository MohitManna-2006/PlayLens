import { describe, expect, it } from "vitest";
import { AnalystStore, contextDiffers, type AnalystTransport } from "./store";
import type { AnalystEvent } from "./schema";

function scripted(events: AnalystEvent[]): AnalystTransport {
  return {
    status: async () => ({ status: "available", mode: "llm", note: null }),
    suggestions: () => [],
    run: async (_req, emit) => {
      for (const e of events) emit(e);
    },
  };
}

const source = {
  id: "s1",
  tool: "get_player_state",
  play_ids: ["p1"],
  player_ids: ["a"],
  frame_range: [3, 3],
  definition: "d",
  dataset_version: null,
  model_version: null,
  request_id: null,
};
const row = { ref: 1, label: "Speed", value: 4.2, unit: "yd/s", decimals: 1, missing_reason: null, frame_id: 3, source_id: "s1" };

async function run(events: AnalystEvent[]) {
  const store = new AnalystStore(scripted(events));
  store.bindWorkspace({ getContext: () => ({ kind: "play", play_id: "p1", player_id: "a", player_label: "#1", frame_id: 3 }) });
  store.submit("Question");
  await new Promise((r) => setTimeout(r, 0));
  return { store, response: store.getState().transcripts["play:p1"][0] };
}

describe("analyst generative UI validation (C07)", () => {
  it("mounts a block only after its source is present and valid", async () => {
    const { response } = await run([
      { type: "block", block: { type: "observed", title: "Frame 3", rows: [row] } },
      { type: "source", source },
      { type: "done" },
    ]);
    expect(response.blocks).toHaveLength(1);
    expect(response.rejected).toBe(0);
  });

  it("rejects unknown component types and blocks without provenance", async () => {
    const { response } = await run([
      { type: "block", block: { type: "arbitrary_html", html: "<script>" } },
      { type: "block", block: { type: "observed", title: "Frame 3", rows: [{ ...row, source_id: "missing" }] } },
      { type: "actions", actions: [{ type: "run_sql", sql: "drop" }, { type: "jump_to_frame", play_id: "p1", frame_id: 3 }] },
      { type: "done" },
    ]);
    expect(response.blocks).toHaveLength(0);
    expect(response.actions).toHaveLength(1);
    expect(response.rejected).toBe(3);
  });

  it("refuses to apply a pinned action once a different play is open", async () => {
    const { store, response } = await run([{ type: "done" }]);
    store.bindWorkspace({ getContext: () => ({ kind: "play", play_id: "p2", player_id: null, player_label: null, frame_id: 1 }) });
    const outcome = store.runAction({ type: "jump_to_frame", play_id: "p1", frame_id: 3 }, response.context);
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/not open/);
  });

  it("flags older answers when selection or frame changed", () => {
    const a = { kind: "play" as const, play_id: "p1", player_id: "a", player_label: null, frame_id: 3 };
    expect(contextDiffers(a, { ...a, frame_id: 4 })).toBe(true);
    expect(contextDiffers(a, { ...a })).toBe(false);
  });
});
