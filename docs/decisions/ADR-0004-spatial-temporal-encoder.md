# ADR-0004: Spatial-temporal encoder and trajectory head

Date: 2026-09-30

## Context

PlayLens needs one learned encoder whose play representation serves trajectory prediction now and retrieval next (Masterbrain §11). The data limits the design: 1–17 tracked players per play (no linemen or pass rushers), no ball track, observed windows of 8–123 frames, supplied futures of 5–94 frames, futures only for flagged players, 10 Hz. Training runs on a laptop (Apple M1 Pro, MPS).

## Decision

**Input window.** The last `W = 20` observed frames (2.0 s), right-aligned at the last observed frame (the prediction origin). 86% of plays (85.9% of train plays) fill it; shorter plays (minimum 8 frames) are front-padded and masked, never dropped.

**Horizon.** `H` = the smallest number of steps covering 95% of train-split target players' supplied futures = 24 steps (2.4 s). On the train split that fully covers 95.5% of target players and 98.5% of supplied target frames; the remaining 1.5% of frames (beyond step 24) are not scored, and 50% of the H-step slots are masked because most futures are shorter. The model never sees the supplied horizon length.

**Graph per frame.** Nodes are the tracked players present in the frame. Each node receives directed edges from its `k = 4` nearest present players by canonical Euclidean distance (fewer in small frames; none for a single player). No self edges in the graph; the message layer adds self loops. Offense and defense are not filtered. Edge features: relative position (dx, dy, yards/10), distance (yards/10), relative velocity (yd/s / 5), and a same-side flag. Ties are broken by player slot, so graphs are deterministic. No coverage or assignment semantics are encoded.

**Architecture** (`playlens_ml/models/encoder.py`, `trajectory.py`, hidden size 96, 289k parameters):

1. Node input: 14 standardized numeric features, embeddings (8-d) for side, position, role, and the `player_to_predict` flag → 2-layer MLP.
2. Spatial: 2 pre-norm residual **GATv2** layers (4 heads, `edge_dim` = 6) per frame. GATv2 consumes edge features directly and learns per-neighbour attention, which a mean-aggregating GraphSAGE cannot. Padded nodes are zeroed and have no edges.
3. Temporal: per-player 2-layer pre-norm **Transformer encoder** (4 heads, learned position embedding aligned to the origin) with a key-padding mask over padded frames. The output at the origin slot is the player's contextual state. Nothing after the origin exists in the input.
4. Interaction at the origin: one more GATv2 layer over the players' contextual states on the origin-frame kNN graph.
5. Play embedding: attention pooling over players → linear → LayerNorm → **128-d**. Exported L2-normalised for retrieval.
6. Trajectory head: MLP on [player state, play embedding] → H × 2.

**Target representation: residual over constant velocity.** `p̂(k) = p_last + v_last·k·0.1 s + r(k)`. The head's last layer is zero-initialised, so the untrained model *is* the constant-velocity baseline (tested) and training learns deviations from straight-line motion. Selected over predicting raw displacement because it starts at a strong, interpretable baseline; the `displacement` variant remains a config option.

**Loss: masked mean Euclidean error** over valid (target player, future step) pairs. It is the quantity ADE reports, in yards, and behaves like L1 (robust to the occasional large deviation); padded steps and non-target players contribute nothing.

**Training.** AdamW (lr 1e-3, weight decay 1e-4), 1 warm-up epoch then cosine decay, gradient clipping 1.0, batch 64 plays, up to 30 epochs with early stopping (patience 6) on validation ADE, y-mirror augmentation with p = 0.5 (reflection across the field's long axis keeps offense attacking +x; y, vy, dy, and cos of angles flip sign). Seed 7.

**Uncertainty: none.** The first model is a deterministic point forecaster. The API reports `uncertainty.kind = "none"` and the UI draws no bands.

## Alternatives considered

- **Full observed history.** Up to 123 frames; most of the signal for a 2.4 s forecast is in the last two seconds, and padding to 123 multiplies compute. A longer window is a cheap later ablation.
- **Fixed horizon at the longest future.** Masks 70%+ of slots for little extra coverage.
- **GraphSAGE / GCN.** Cannot use edge features; distance and relative velocity are the main interaction signals.
- **Radius graph.** Player spacing varies too much across plays for one stable radius; kNN keeps degree bounded.
- **A separate embedding model.** Rejected by the Masterbrain: the embedding must come from the encoder that is actually trained.
- **Temporal-only ablation** (no GNN, no interaction layer, `configs/trajectory_temporal_only.yaml`) is kept as the lightweight learned baseline that tests whether the graph adds value.

## Consequences

- One encoder serves forecasting and embeddings; retrieval (Phase 4) consumes `data/processed/.../embeddings/<model_version>.parquet`.
- Forecasts start only at the end of the observed window. The web app pins the origin there for this model.
- MPS kernels for scatter-based attention are not bit-deterministic; CPU inference is deterministic (tested), and exported embeddings are produced on CPU.

## Result (2026-09-30)

The temporal-only ablation matched the full model on validation (ADE 0.354 vs 0.356 yd, FDE 0.982 vs 0.977 yd; paired differences within ±0.02 yd). The graph layers are kept in v1 because the design was fixed before the test evaluation, but their value is not demonstrated. See [the evaluation summary](../evaluation/trajectory-gnn-transformer-v1.md).

## Revisit trigger

- The model stops beating constant velocity on a slice with enough samples.
- A graph variant fails to beat the temporal-only model on validation again → simplify to temporal-only, or change the graph (radius or role-aware edges, more interaction layers).
- Uncertainty is required for the product (sampled futures, quantiles, or a mixture density head).
- Ball tracking or full 22-player tracking becomes available.
