# Phase 3: ML foundation

Phase 3 trains the first PlayLens model on the canonical Phase 2 data, evaluates it against constant-velocity baselines, exports a versioned artifact and play embeddings, and serves real forecasts through the API to the existing Play view.

Decisions: [ADR-0003 split and leakage policy](../decisions/ADR-0003-ml-split-and-leakage-policy.md), [ADR-0004 encoder and trajectory head](../decisions/ADR-0004-spatial-temporal-encoder.md). Results: [model card](../model-cards/trajectory-gnn-transformer-v1.md), [evaluation summary](../evaluation/trajectory-gnn-transformer-v1.md).

## Pipeline

```text
data/processed/<ds>/full/            (Phase 2 canonical Parquet)
  └─ pnpm ml:splits ─────────────▶ ml/splits.parquet, splits.json
                                    data/manifests/<ds>.full.splits.json      (committed)
  └─ samples (cached) ───────────▶ ml/samples-w20-h24-<key>.npz             (~313 MB, ignored)
  └─ pnpm ml:train ──────────────▶ artifacts/runs/<run_id>/                  (config, history, best.pt, env)
                                    artifacts/evaluation/<run_id>/{model,cv,cv-fd}-{validation,test}/
                                    artifacts/models/<model_version>/         (model.pt, model.json, evaluation.json)
                                    mlruns/                                   (local MLflow)
  └─ pnpm ml:benchmark ──────────▶ artifacts/models/<v>/benchmark.json
  └─ pnpm ml:embeddings ─────────▶ data/processed/<ds>/full/embeddings/<v>.parquet
                                    data/manifests/<ds>.full.embeddings.<v>.json (committed)
  └─ pnpm ml:sanity ─────────────▶ artifacts/evaluation/embeddings/<v>/sanity.json
services/api  ── loads artifacts/models/* at startup ──▶ GET /api/v1/models
                                                          POST /api/v1/predict/trajectory
                                                          GET /api/v1/evaluation/summary
apps/web      ── Play view predicted-path overlay (real API, no fixture fallback)
```

## Modules (`ml/src/playlens_ml`)

| Module | Role |
|---|---|
| `datasets/splits.py` | `temporal-weeks-v1` policy, game-safe assignment, content-addressed split version, CLI |
| `features/spec.py` | Feature allowlist, exclusions with reasons, availability guard |
| `features/samples.py` | Canonical tables → padded per-player windows, targets, masks (`SampleSet`) |
| `features/encoding.py` | Train-only vocabularies and standardization |
| `datasets/trajectory.py` | Horizon policy, sample cache, batching, mirror augmentation |
| `graphs/knn.py` | Per-frame directed kNN graph with edge features |
| `models/baselines.py` | Constant velocity (supplied velocity, finite difference) |
| `models/encoder.py` | GATv2 spatial layers + per-player Transformer + interaction layer + pooled play embedding |
| `models/trajectory.py` | Residual-to-CV trajectory head and masked displacement loss |
| `evaluation/` | ADE/FDE, horizon curve, slices, report files, cluster bootstrap, CLI |
| `training/` | YAML config, device selection, seeding, MLflow wrapper, train loop, export |
| `inference/` | Versioned artifact with checksum, predictor with typed unsupported reasons, benchmark |
| `embeddings/` | Embedding export with validation, sanity checks against a metadata baseline |

## Commands

```bash
pnpm ml:splits                    # split assignment + manifest
pnpm ml:baseline                  # constant velocity on validation (no training)
pnpm ml:overfit                   # 32 train plays, 150 epochs (reference run: ADE 1.043 -> 0.129 yd)
pnpm ml:train                     # full run; validation selection, then one test evaluation, then export
pnpm ml:benchmark                 # CPU latency (add `-- --device mps` for MPS)
pnpm ml:embeddings && pnpm ml:sanity
pnpm mlflow:ui                    # http://localhost:5001
```

Overrides: `uv run python -m playlens_ml.training.train --config <yaml> --epochs 4 --max-train-plays 2000 --device cpu --no-mlflow --no-export --model-version <name>`.

## Reproducibility

Each run writes `artifacts/runs/<run_id>/{config.json, history.json, summary.json, best.pt}`. The summary records the run ID, dataset and split versions, window and horizon, play counts, parameter count, best epoch, metrics, and an `environment` block (git commit and dirty flag, Python and package versions, device, and a note on nondeterminism); the model artifact repeats the split policy, games per split, feature schema version, and config. Config, metadata, per-epoch metrics, and the artifact are also logged to local MLflow. Seeds are fixed for Python, NumPy, torch, batch order, and augmentation. CPU training and inference are deterministic; MPS scatter kernels are not bit-exact, so two MPS runs agree closely but not exactly. Embeddings are exported on CPU and checked for determinism.

## Artifact policy

- Committed: code, configs, split and embedding manifests (counts, hashes, versions), docs, and a small evaluation summary in `docs/evaluation/`.
- Ignored: `artifacts/` (runs, checkpoints, evaluation tables, model weights), `mlruns/`, `data/processed/` (sample cache, embeddings). The model weights are 1.2 MB, but they are derived from data under competition terms and are reproducible with `pnpm ml:train`; the artifact checksum is in `model.json` and the model card.

## Serving

The API loads every `artifacts/models/*/model.json` at startup (override with `PLAYLENS_MODEL_DIR`), validates the format, feature schema version, and weight checksum, and runs inference on CPU (`PLAYLENS_MODEL_DEVICE`). With no artifact, `/api/v1/models` returns `[]` and forecasts return `503 model_unavailable`.

`POST /api/v1/predict/trajectory` body: `{play_id, model_version?, origin_frame_id?, horizon_s?, player_ids?}`. The origin must be the play's last observed frame (the end of the dataset's input window); any other frame returns `422 unsupported_origin`. The response carries model name and version, dataset and split versions, which split the play's game belonged to, output frame IDs for each step, a per-step `valid` mask (steps the dataset supplies an actual position for), latency, and `uncertainty.kind = "none"`.

## Web

The Play view's existing predicted-path overlay calls the real endpoint. For this model the origin is fixed at the last observed frame, so the control offers one action: run a forecast from that frame. All target players' predicted paths are drawn (dashed), the selected player's emphasized, over the steps the dataset supplies an actual future for (the same steps that are scored; the model itself never sees that length); the held-out actual future is a separate solid overlay toggle. The panel shows model version, split membership of the play, input window, horizon, server latency, and ADE/FDE against the actual future for that play (computed in the browser with the evaluation definitions). Errors and unsupported plays show their reason; nothing falls back to fixture data.
