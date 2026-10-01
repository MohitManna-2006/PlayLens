# Evaluation: trajectory-gnn-transformer-v1

All numbers come from the training run `trajectory-gnn-transformer-20261001T031301Z-bb8cfa` (MLflow `9de5c7e09c3e4e9faa6e4882fe626fd6`) and the commands that followed it. The machine-readable copy is [trajectory-gnn-transformer-v1.json](trajectory-gnn-transformer-v1.json); the full tables (per-step predictions, slices) are in `artifacts/evaluation/<run_id>/` after a local run.

- Dataset `nfl_bdb_2026_analytics@full-91dc5311e8c7`, split `temporal-weeks-v1-b39c53db8a01` (train weeks 1–14, validation 15–16, test 17–18).
- Task: future canonical x/y of every `player_to_predict` player, from the last observed frame, 24 steps (2.4 s). Steps beyond the dataset's supplied future are not scored.
- Metrics are means over target players of per-player ADE (mean error over that player's scored steps) and FDE (error at the last scored step), in yards. Intervals are 95% cluster-bootstrap intervals over plays (1,000 resamples, seed 7).
- The checkpoint was chosen on validation ADE. Test was evaluated once, after selection.

## Headline

| Split | Predictor | ADE (yd) | 95% interval | FDE (yd) | 95% interval | Players | Plays |
|---|---|---:|---|---:|---|---:|---:|
| test | **model** | **0.348** | 0.334–0.364 | **0.954** | 0.913–1.000 | 5,038 | 1,559 |
| test | constant velocity (supplied) | 1.090 | 1.050–1.130 | 2.691 | 2.591–2.789 | 5,038 | 1,559 |
| test | constant velocity (finite difference) | 1.160 | 1.120–1.202 | 2.809 | 2.708–2.909 | 5,038 | 1,559 |
| validation | model | 0.356 | 0.339–0.373 | 0.977 | 0.926–1.027 | 5,540 | 1,687 |
| validation | constant velocity (supplied) | 1.095 | 1.054–1.134 | 2.717 | 2.614–2.813 | 5,540 | 1,687 |
| validation | constant velocity (finite difference) | 1.167 | 1.124–1.206 | 2.837 | 2.731–2.933 | 5,540 | 1,687 |

On test the model's ADE is 68% lower than supplied-velocity constant velocity, and FDE is 65% lower. Validation and test agree closely, so the selected checkpoint does not look overfit to validation.

## Error by horizon (test)

Mean error at each future step over target players whose supplied future reaches that step.

| Step | Time | Players | Model (yd) | CV supplied (yd) | CV finite diff. (yd) |
|---:|---:|---:|---:|---:|---:|
| 1 | 0.1 s | 5,038 | 0.011 | 0.027 | 0.040 |
| 5 | 0.5 s | 5,038 | 0.136 | 0.506 | 0.566 |
| 10 | 1.0 s | 3,138 | 0.562 | 1.832 | 1.936 |
| 15 | 1.5 s | 1,367 | 1.185 | 3.428 | 3.557 |
| 20 | 2.0 s | 638 | 1.764 | 4.808 | 4.947 |
| 24 | 2.4 s | 285 | 2.224 | 5.834 | 5.967 |

Fewer players reach later steps, because most passes arrive within a second; later steps describe longer passes only.

## Slices (test)

Slices with fewer than 100 target players are marked insufficient and not interpreted.

| Slice | Players | Model ADE | Model FDE | CV ADE | CV FDE |
|---|---:|---:|---:|---:|---:|
| Targeted receiver (offense) | 1,559 | 0.279 | 0.798 | 0.874 | 2.099 |
| Defensive coverage (defense) | 3,479 | 0.379 | 1.023 | 1.186 | 2.957 |
| CB | 1,481 | 0.406 | 1.110 | 1.260 | 3.143 |
| FS | 476 | 0.447 | 1.204 | 1.438 | 3.606 |
| SS | 508 | 0.425 | 1.166 | 1.366 | 3.420 |
| ILB | 440 | 0.287 | 0.744 | 0.877 | 2.152 |
| MLB | 265 | 0.279 | 0.740 | 0.852 | 2.144 |
| OLB | 272 | 0.271 | 0.703 | 0.857 | 2.100 |
| WR | 905 | 0.340 | 0.982 | 1.111 | 2.672 |
| TE | 386 | 0.206 | 0.578 | 0.589 | 1.401 |
| RB | 237 | 0.162 | 0.425 | 0.428 | 1.027 |
| Supplied future 1–10 frames | 2,461 | 0.163 | 0.423 | 0.553 | 1.338 |
| Supplied future 11–20 frames | 2,006 | 0.438 | 1.240 | 1.381 | 3.470 |
| Supplied future 21+ frames | 571 | 0.831 | 2.237 | 2.381 | 5.789 |

Insufficient (<100 players): DE 14, DT 4, FB 12, NT 2, QB 5, S 30, T 1.

The model beats constant velocity in every sufficient slice. Safeties and corners are hardest; errors grow with how long the ball is in the air.

## Failure cases (test)

- For 425 of 5,038 target players (8.4%) the model's ADE is worse than constant velocity's.
- 77 players have ADE above 1.5 yd. The six worst are all defenders (CB ×3, SS, FS, ILB) with ADE 2.96–3.50 yd. In one, a free safety kept moving nearly straight (CV ADE 0.99 yd) while the model predicted a change of direction (ADE 3.46 yd); in the others both predictors are far off.
- Per-player ADE: median 0.232 yd, 90th percentile 0.771 yd, 99th percentile 1.666 yd.

## Ablation: is the spatial graph useful?

`configs/trajectory_temporal_only.yaml` (run `trajectory-temporal-only-20261001T033354Z-acabae`): the same pipeline with no GATv2 layers and no interaction layer (230,265 parameters vs 289,017). Compared on **validation only**; its test split was not evaluated.

| Model | Validation ADE | Validation FDE |
|---|---:|---:|
| GNN + Transformer (served) | 0.356 | 0.977 |
| Temporal only | 0.354 | 0.982 |

Paired difference (GNN − temporal-only) over the same 5,540 players, cluster bootstrap over plays: ADE +0.002 yd (−0.002 to +0.007), FDE −0.004 yd (−0.018 to +0.008). **The graph layers do not measurably improve forecasts on validation.** The served model is the pre-planned GNN design (ADR-0004), whose single test evaluation was already run; this result is recorded as a finding, not used to pick between models on test. The temporal-only model still sees other players through the pooled play embedding that feeds every player's head, so this tests explicit graph message passing, not all use of other players.

## Training

30 epochs on Apple M1 Pro (MPS), 1,116 s. The untrained model (epoch 0) scored exactly the constant-velocity validation ADE (1.095), as designed. Validation ADE fell to 0.742 after epoch 1, 0.438 after epoch 8, 0.371 after epoch 20, and 0.356 at epochs 29–30. Training reached the 30-epoch limit without triggering early stopping; with cosine decay the learning rate was near zero by then, so longer training would need a different schedule.

Reality checks run before the full run: 32 train plays overfit from validation ADE 1.043 to 0.129 yd in 150 epochs; a 2,000-play, 4-epoch run reached 0.671 yd.

## Inference latency

`TrajectoryPredictor.predict_play` (feature build + forward pass, one play per call, warm; data loading and HTTP excluded), 200 hash-chosen test plays after 10 warm-up calls, Apple M1 Pro:

| Device | p50 | p95 | p99 | Mean |
|---|---:|---:|---:|---:|
| CPU (6 threads) | 21.6 ms | 33.5 ms | 42.0 ms | 22.0 ms |
| MPS | 24.1 ms | 37.1 ms | 229.3 ms | 29.6 ms |

The API serves on CPU. One request through the running API, including data access, measured 30 ms server side and 70 ms at the client (first request after startup).

## Embedding sanity

Play embeddings (128-d, L2-normalised) for all 14,108 plays. For each test play, the 10 nearest train plays by cosine; the score is the share of neighbours with the same charted label. Labels are not model inputs.

| Label | Learned | Metadata baseline | Random |
|---|---:|---:|---:|
| Offense formation | 0.583 | 0.556 | 0.546 |
| Receiver alignment | 0.400 | 0.373 | 0.357 |
| Coverage man/zone | 0.679 | 0.637 | 0.601 |
| Coverage type | 0.271 | 0.239 | 0.211 |
| Targeted receiver's route | 0.689 | 0.129 | 0.119 |

The metadata baseline uses down, distance band, quarter, and field zone. The learned embedding beats both baselines on every label. The gain is large for the targeted receiver's route, which the observed motion shows directly, and small for formation and coverage. Embeddings are anisotropic: random pairs have mean cosine 0.44, and the mean vector has norm 0.67. Retrieval should rank by relative similarity, and may benefit from centering.
