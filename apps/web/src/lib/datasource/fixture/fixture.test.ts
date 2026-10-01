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
    expect(page.items.every((p) => p.id === `${p.game_id}-${p.play_id}`)).toBe(true);
    const dates = page.items.map((p) => p.game_date ?? "");
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it("parses every play and frame payload and keeps players inside the field", async () => {
    const page = await client.listPlays({ sort: "recent", page: 1, page_size: 200 });
    for (const summary of page.items) {
      const detail = await client.getPlay(summary.id);
      const frames = await client.getFrames(summary.id);
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
    const detail = await client.getPlay("9-3");
    const series = buildSeries(detail, await client.getFrames("9-3"));
    expect(series.gaps.length).toBe(1);
    const noBall = buildSeries(await client.getPlay("9-5"), await client.getFrames("9-5"));
    expect(noBall.ball).toBeNull();
    const noSnap = buildSeries(await client.getPlay("9-7"), await client.getFrames("9-7"));
    expect(noSnap.snapIndex).toBeNull();
  });

  it("excludes the self-match from retrieval and ranks by cosine", async () => {
    const r = await client.findSimilar({ play_id: "10-1", k: 5 });
    expect(r.results.map((x) => x.play.id)).not.toContain("10-1");
    const scores = r.results.map((x) => x.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    scores.forEach((s) => expect(Math.abs(s)).toBeLessThanOrEqual(1 + 1e-9));
  });

  it("predicts a straight constant-velocity path from the origin", async () => {
    const detail = await client.getPlay("10-1");
    const series = buildSeries(detail, await client.getFrames("10-1"));
    const origin = series.frameIds[series.snapIndex! + 10];
    const pred = await client.predictTrajectory({ play_id: "10-1", origin_frame_id: origin, horizon_s: 2, player_ids: null });
    expect(pred.players[0].path).toHaveLength(20);
    const p = pred.players.find((x) => x.path.length)!;
    const d1 = { x: p.path[1].x - p.path[0].x, y: p.path[1].y - p.path[0].y };
    const d2 = { x: p.path[19].x - p.path[18].x, y: p.path[19].y - p.path[18].y };
    expect(d1.x).toBeCloseTo(d2.x, 6);
    expect(d1.y).toBeCloseTo(d2.y, 6);
    await expect(
      client.predictTrajectory({ play_id: "10-1", origin_frame_id: series.frameIds[0], horizon_s: 2, player_ids: null }),
    ).rejects.toThrow();
  });

  it("validates PlayLab edits against supplied bounds and rejects invalid ones", async () => {
    const config = await client.getPlayLabConfig("10-1");
    expect(config.available).toBe(true);
    const detail = await client.getPlay("10-1");
    const series = buildSeries(detail, await client.getFrames("10-1"));
    const e = series.frameIds.indexOf(config.editable_frame_id!);
    const pid = config.eligible_player_ids[0];
    const t = series.tracks.find((x) => x.ref.player_id === pid)!;
    const original = { x: t.x[e], y: t.y[e] };
    expect(validateEdit(config, original, { x: original.x, y: original.y + 7 })).toMatch(/yd from the source/);
    const ok = { x: original.x, y: Math.min(53, original.y + 2) };
    if (validateEdit(config, original, ok) === null) {
      const r = await client.runCounterfactual({
        play_id: "10-1",
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
        play_id: "10-1",
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

describe("fixture honesty", () => {
  it("invents no charting labels, formations, or held-out future", async () => {
    const page = await client.listPlays({ sort: "recent", page: 1, page_size: 200 });
    for (const p of page.items) {
      expect(p.annotations.coverage_type).toBeNull();
      expect(p.context.offense_formation).toBeNull();
      expect(p.tracking.future_frame_count).toBe(0);
    }
    await expect(client.getFuture(page.items[0].id)).rejects.toMatchObject({ kind: "unavailable" });
    expect((await client.getDataset()).synthetic).toBe(true);
  });

  it("serves canonical coordinates: offense starts behind the line of scrimmage on every play", async () => {
    const page = await client.listPlays({ sort: "recent", page: 1, page_size: 200 });
    for (const summary of page.items.slice(0, 20)) {
      const detail = await client.getPlay(summary.id);
      const series = buildSeries(detail, await client.getFrames(summary.id));
      const qb = series.tracks.find((t) => t.ref.position === "QB")!;
      expect(qb.x[0]).toBeLessThan(detail.line_of_scrimmage_x!);
    }
  });
});
