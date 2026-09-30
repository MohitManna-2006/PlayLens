import { describe, expect, it } from "vitest";
import { createClient } from "../index";
import { FixtureSource } from "./index";
import { buildSeries } from "@/lib/tracking/series";
import { validateEdit } from "@/lib/playlab/validate";

const client = createClient(new FixtureSource());

describe("fixture source honours the contract", () => {
  it("lists plays newest game first with 50-per-page pagination", async () => {
    const page = await client.listPlays({ sort: "recent", page: 1, page_size: 50 });
    expect(page.total).toBe(120);
    expect(page.items).toHaveLength(50);
    expect(page.dataset.synthetic).toBe(true);
    const dates = page.items.map((p) => p.game_date ?? "");
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("parses every play and frame payload and keeps players inside the field", async () => {
    const page = await client.listPlays({ sort: "recent", page: 1, page_size: 200 });
    for (const summary of page.items) {
      const detail = await client.getPlay(summary.play_id);
      const frames = await client.getFrames(summary.play_id);
      const series = buildSeries(detail, frames);
      expect(series.tracks).toHaveLength(22);
      for (const t of series.tracks) {
        for (let i = 0; i < series.times.length; i++) {
          if (!Number.isFinite(t.x[i])) continue;
          expect(t.x[i]).toBeGreaterThanOrEqual(-0.2);
          expect(t.x[i]).toBeLessThanOrEqual(120.2);
          expect(t.y[i]).toBeGreaterThanOrEqual(-0.2);
          expect(t.y[i]).toBeLessThanOrEqual(53.6);
        }
      }
    }
  }, 30000);

  it("exposes the special cases used by empty and failure states", async () => {
    const detail = await client.getPlay("fx09-003");
    const series = buildSeries(detail, await client.getFrames("fx09-003"));
    expect(series.gaps.length).toBe(1);
    const noBall = buildSeries(await client.getPlay("fx09-005"), await client.getFrames("fx09-005"));
    expect(noBall.ball).toBeNull();
    const noSnap = buildSeries(await client.getPlay("fx09-007"), await client.getFrames("fx09-007"));
    expect(noSnap.snapIndex).toBeNull();
  });

  it("excludes the self-match from retrieval and ranks by cosine", async () => {
    const r = await client.findSimilar({ play_id: "fx10-001", k: 5 });
    expect(r.results.map((x) => x.play.play_id)).not.toContain("fx10-001");
    const scores = r.results.map((x) => x.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    scores.forEach((s) => expect(Math.abs(s)).toBeLessThanOrEqual(1 + 1e-9));
  });

  it("predicts a straight constant-velocity path from the origin", async () => {
    const detail = await client.getPlay("fx10-001");
    const series = buildSeries(detail, await client.getFrames("fx10-001"));
    const origin = series.frameIds[series.snapIndex! + 10];
    const pred = await client.predictTrajectory({ play_id: "fx10-001", origin_frame_id: origin, horizon_s: 2, player_ids: null });
    expect(pred.players[0].path).toHaveLength(20);
    const p = pred.players.find((x) => x.path.length)!;
    const d1 = { x: p.path[1].x - p.path[0].x, y: p.path[1].y - p.path[0].y };
    const d2 = { x: p.path[19].x - p.path[18].x, y: p.path[19].y - p.path[18].y };
    expect(d1.x).toBeCloseTo(d2.x, 6);
    expect(d1.y).toBeCloseTo(d2.y, 6);
    await expect(
      client.predictTrajectory({ play_id: "fx10-001", origin_frame_id: series.frameIds[0], horizon_s: 2, player_ids: null }),
    ).rejects.toThrow();
  });

  it("validates PlayLab edits against supplied bounds and rejects invalid ones", async () => {
    const config = await client.getPlayLabConfig("fx10-001");
    expect(config.available).toBe(true);
    const detail = await client.getPlay("fx10-001");
    const series = buildSeries(detail, await client.getFrames("fx10-001"));
    const e = series.frameIds.indexOf(config.editable_frame_id!);
    const pid = config.eligible_player_ids[0];
    const t = series.tracks.find((x) => x.ref.player_id === pid)!;
    const original = { x: t.x[e], y: t.y[e] };
    expect(validateEdit(config, original, { x: original.x, y: original.y + 7 })).toMatch(/yd from the source/);
    const ok = { x: original.x, y: Math.min(53, original.y + 2) };
    if (validateEdit(config, original, ok) === null) {
      const r = await client.runCounterfactual({
        play_id: "fx10-001",
        model_version: config.model_version!,
        editable_frame_id: config.editable_frame_id!,
        player_id: pid,
        x: ok.x,
        y: ok.y,
      });
      expect(r.original).toHaveLength(22);
      expect(r.measures[0].modified).toBeCloseTo(Math.hypot(ok.x - original.x, ok.y - original.y));
    }
    await expect(
      client.runCounterfactual({
        play_id: "fx10-001",
        model_version: config.model_version!,
        editable_frame_id: config.editable_frame_id!,
        player_id: pid,
        x: original.x,
        y: original.y + 9,
      }),
    ).rejects.toThrow(/rejected/);
  });

  it("reports fixture models as not evaluated rather than inventing metrics", async () => {
    for (const m of await client.listModels()) {
      const report = await client.getEvaluation(m.model_version);
      expect(report.status).not.toBe("complete");
      expect(report.trajectory).toBeNull();
      expect(report.system).toBeNull();
    }
  });
});
