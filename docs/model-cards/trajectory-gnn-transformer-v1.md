# Model card: trajectory-gnn-transformer-v1

| | |
|---|---|
| Model name | `trajectory-gnn-transformer` |
| Version | `trajectory-gnn-transformer-v1` |
| Task | Future positions of the dataset's target players after the last observed frame |
| Status | Served by the API on CPU; drawn in the Play view's predicted-path overlay |
| Run | `trajectory-gnn-transformer-20261001T031301Z-bb8cfa` (MLflow `9de5c7e09c3e4e9faa6e4882fe626fd6`) |
| Dataset | `nfl_bdb_2026_analytics@full-91dc5311e8c7` (NFL Big Data Bowl 2026 Analytics, 2023 season, 14,108 plays) |
| Split | `temporal-weeks-v1-b39c53db8a01`: train weeks 1–14 (10,862 plays), validation 15–16 (1,687), test 17–18 (1,559) |
| Code | git `b55897b` with uncommitted Phase 3 changes (`dirty: true` in the run record) |
| Weights | `model.pt`, 1,177,893 bytes, sha256 `9090b48536ef28ab74584239ca66bf6bf94cb4a30ae66f69dcd7f1f326448e9d`; 289,017 parameters |
| Artifact | `artifacts/models/trajectory-gnn-transformer-v1/` (Git-ignored; rebuild with `pnpm ml:train`) |
| Config | `configs/trajectory_gnn_transformer.yaml` |

## What it predicts

For every player the dataset flags `player_to_predict` (the targeted receiver and the flagged coverage defenders), 24 future canonical (x, y) positions at 0.1 s steps, starting one step after the last observed frame (the moment the input files end, when the pass is thrown). Coordinates are PlayLens canonical yards: offense attacks +x, y across the field.

It predicts positions only. It does not predict the ball, catches, completions, yards, or any outcome, and it does not explain why a player moves.

## Inputs

The last 20 observed frames (2.0 s) of every tracked player in the play: canonical x, y; speed; acceleration; direction and orientation (sin/cos); velocity components; frame-to-frame displacement; time relative to the last observed frame; x relative to the line of scrimmage; side; position; role; and the `player_to_predict` flag. Plays with fewer observed frames are padded and masked.

Not used: the ball landing point, the supplied future length, charted coverage/route/dropback/play-action labels, outcomes, pre-snap game context, names, IDs, height, weight, and age. See [ADR-0003](../decisions/ADR-0003-ml-split-and-leakage-policy.md).

## Architecture

Per-frame kNN player graphs (k = 4; edge features: relative position, distance, relative velocity, same side) → 2 GATv2 layers → per-player 2-layer Transformer over the 20 frames → 1 GATv2 interaction layer at the origin → attention pooling into a 128-d play embedding → MLP head that adds a correction to constant-velocity extrapolation for 24 steps. Loss: masked mean Euclidean displacement. See [ADR-0004](../decisions/ADR-0004-spatial-temporal-encoder.md).

## Training

AdamW (lr 1e-3, weight decay 1e-4), batch 64 plays, 1 warm-up epoch then cosine decay, gradient clipping 1.0, y-mirror augmentation (p = 0.5), seed 7. 30 epochs on an Apple M1 Pro with MPS in 1,116 s. Checkpoint chosen by validation ADE (epoch 29). Normalization statistics and vocabularies come from the train split only.

## Evaluation

Full detail: [docs/evaluation/trajectory-gnn-transformer-v1.md](../evaluation/trajectory-gnn-transformer-v1.md).

| Test (weeks 17–18; 5,038 target players, 1,559 plays) | ADE (yd) | FDE (yd) |
|---|---:|---:|
| This model | 0.348 (0.334–0.364) | 0.954 (0.913–1.000) |
| Constant velocity, supplied speed and direction | 1.090 (1.050–1.130) | 2.691 (2.591–2.789) |
| Constant velocity, finite-difference velocity | 1.160 (1.120–1.202) | 2.809 (2.708–2.909) |

95% cluster-bootstrap intervals over plays. Validation: model ADE 0.356 / FDE 0.977 vs constant velocity 1.095 / 2.717. Errors are only scored where the dataset supplies an actual position (up to 24 steps).

Error at 1.0 s is 0.56 yd (constant velocity 1.83 yd) and at 2.0 s is 1.76 yd (4.81 yd), measured on the players whose supplied future reaches that step.

Latency (one play, warm, model only): CPU p50 21.6 ms, p95 33.5 ms, p99 42.0 ms; MPS p50 24.1 ms, p95 37.1 ms, p99 229.3 ms (Apple M1 Pro).

## Limitations

- **The spatial graph is not shown to help.** A temporal-only ablation without GATv2 layers matched it on validation (ADE 0.354 vs 0.356 yd; paired difference within ±0.007 yd). Do not describe this model's accuracy as coming from modelling player interactions.
- **Fixed origin.** It forecasts only from the last observed frame. It cannot forecast from earlier frames of the play.
- **Target players only.** Only players the dataset flagged are forecast; the selection hints at who is involved in the play.
- **No uncertainty.** Point forecasts only; the API reports `uncertainty.kind = "none"` and the UI draws no bands.
- **Error grows with horizon and ball flight time.** Plays with 21+ supplied future frames have ADE 0.83 yd; safeties and corners are hardest (FS 0.45, CB 0.41 yd). For 8.4% of test target players the model is worse than constant velocity.
- **One season, partial tracking.** 2023 only; only the passer, route runners, and coverage defenders are tracked (no offensive linemen or pass rushers); no ball track. Test weeks 17–18 are late-season games. Players and teams in test also appear in training.
- **Not tuned.** One configuration, no hyperparameter search. Training reached its 30-epoch limit without early stopping.

## Intended use

Showing, in PlayLens, where the model expected target players to go after the pass, next to the held-out actual path, to support film-style review. It is not intended for betting, fantasy, player evaluation, injury, or outcome prediction, and its forecasts are not causal statements about what a player "should" have done.

## Embeddings

The same encoder's 128-d play embedding is exported for all 14,108 plays (`data/processed/.../embeddings/trajectory-gnn-transformer-v1.parquet`, manifest committed). Nearest-neighbour label agreement beats a down/distance/quarter/field-zone baseline on every charted label checked; see the evaluation summary. No retrieval feature uses it yet.
