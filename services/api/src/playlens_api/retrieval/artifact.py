"""The Phase 3 embedding export: location, loading, and validation.

The export is the only source of vectors. Nothing here recomputes, centers, or
renormalises them; validation rejects an export rather than repairing it.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
import polars as pl
from playlens_ml.data.artifacts import ProcessedLayout, load_processed, sha256_file
from playlens_ml.data.bdb2026.spec import DATASET_NAME
from playlens_ml.data.ids import InvalidPlayIdError, decode_play_id
from playlens_ml.data.paths import data_layout, find_repo_root

SPLITS = ("train", "validation", "test")
NORM_TOLERANCE = 1e-5
KEY = ["game_id", "play_id"]
REQUIRED_COLUMNS = ("id", "game_id", "play_id", "split", "model_version", "embedding")


class EmbeddingArtifactError(RuntimeError):
    """The embedding export is missing or fails validation."""


@dataclass(frozen=True)
class EmbeddingArtifact:
    model_version: str
    subset: str
    path: Path
    manifest_path: Path
    manifest: dict[str, Any]
    table: pl.DataFrame

    @property
    def vectors(self) -> np.ndarray:
        out: np.ndarray = np.asarray(self.table["embedding"].to_numpy(), np.float32)
        return out

    @property
    def ids(self) -> list[str]:
        return [str(v) for v in self.table["id"].to_list()]

    @property
    def dataset_version(self) -> str:
        return str(self.manifest["dataset_version"])

    @property
    def split_version(self) -> str:
        return str(self.manifest["split_version"])

    @property
    def dimension(self) -> int:
        return int(self.manifest["dimension"])


@dataclass
class ValidationReport:
    checks: dict[str, Any] = field(default_factory=dict)
    notes: list[str] = field(default_factory=list)


def artifact_paths(
    model_version: str, subset: str, data_root: Path | None = None
) -> tuple[Path, Path]:
    layout = data_layout(root=data_root)
    processed = ProcessedLayout.for_subset(layout.processed, DATASET_NAME, subset)
    return (
        processed.root / "embeddings" / f"{model_version}.parquet",
        layout.manifests / f"{DATASET_NAME}.{subset}.embeddings.{model_version}.json",
    )


def load_artifact(
    model_version: str, subset: str = "full", data_root: Path | None = None
) -> EmbeddingArtifact:
    path, manifest_path = artifact_paths(model_version, subset, data_root)
    if not path.is_file():
        raise EmbeddingArtifactError(
            "Phase 3 embedding artifact not found.\n"
            f"  Expected model: {model_version}\n"
            f"  Expected file:  {path}\n"
            "Run the documented Phase 3 workflow first: `pnpm data:full`, "
            "`pnpm ml:splits`, `pnpm ml:train` (or copy the trained artifact into "
            f"artifacts/models/{model_version}/), then `pnpm ml:embeddings`."
        )
    if not manifest_path.is_file():
        raise EmbeddingArtifactError(
            f"Embedding manifest not found: {manifest_path}. It is written by "
            "`pnpm ml:embeddings` next to the export and committed."
        )
    manifest: dict[str, Any] = json.loads(manifest_path.read_text())
    table = pl.read_parquet(path)
    missing = [c for c in REQUIRED_COLUMNS if c not in table.columns]
    if missing:
        raise EmbeddingArtifactError(f"{path} lacks columns {missing}.")
    return EmbeddingArtifact(
        model_version, subset, path, manifest_path, manifest, table
    )


def validate_artifact(
    art: EmbeddingArtifact,
    data_root: Path | None = None,
    expected_dimension: int | None = None,
) -> ValidationReport:
    """Every check from docs/architecture/phase-4-retrieval-compare.md#ingestion.

    Raises EmbeddingArtifactError listing every failed check."""
    report = ValidationReport()
    problems: list[str] = []
    m, t = art.manifest, art.table

    def check(name: str, ok: bool, detail: str, value: Any = None) -> None:
        report.checks[name] = value if value is not None else ok
        if not ok:
            problems.append(detail)

    check(
        "manifest_model_version",
        m.get("model_version") == art.model_version,
        f"manifest names model {m.get('model_version')}, not {art.model_version}",
    )
    versions = set(t["model_version"].unique().to_list())
    check(
        "rows_model_version",
        versions == {art.model_version},
        f"rows name model versions {sorted(versions)}",
    )
    digest = sha256_file(art.path)
    check(
        "artifact_sha256_matches_manifest",
        digest == m.get("sha256"),
        f"artifact sha256 {digest[:12]} != manifest {str(m.get('sha256'))[:12]} "
        "(re-export with `pnpm ml:embeddings`, which rewrites both)",
    )
    vectors = art.vectors
    dim = int(vectors.shape[1]) if vectors.ndim == 2 else -1
    expected = expected_dimension or int(m.get("dimension", -1))
    check(
        "dimension",
        dim == expected == int(m.get("dimension", -1)),
        f"vectors have dimension {dim}; manifest {m.get('dimension')}, "
        f"database column {expected}",
        dim,
    )
    finite = bool(np.isfinite(vectors).all())
    check("finite", finite, "embeddings contain NaN or Inf")
    norms = np.linalg.norm(vectors.astype(np.float64), axis=1)
    deviation = float(np.abs(norms - 1.0).max()) if len(norms) else 0.0
    check(
        "unit_norm_max_deviation",
        finite and deviation <= NORM_TOLERANCE,
        f"vectors are not L2-normalised (max |norm - 1| = {deviation:.2e} > "
        f"{NORM_TOLERANCE})",
        deviation,
    )
    unique = t.select("id", "model_version").unique().height == t.height
    check("unique_play_model_pairs", unique, "duplicate (play, model_version) rows")
    bad_ids = []
    for pid, g, p in zip(t["id"], t["game_id"], t["play_id"], strict=True):
        try:
            if decode_play_id(pid) != (g, p):
                bad_ids.append(pid)
        except InvalidPlayIdError:
            bad_ids.append(pid)
    check(
        "play_ids_valid",
        not bad_ids,
        f"{len(bad_ids)} malformed or inconsistent play IDs, e.g. {bad_ids[:3]}",
    )
    bad_splits = sorted(set(t["split"].unique().to_list()) - set(SPLITS))
    check("split_values", not bad_splits, f"unknown split labels {bad_splits}")
    rows = int(m.get("checks", {}).get("rows", -1))
    check(
        "row_count_matches_manifest",
        t.height == rows,
        f"artifact has {t.height} rows, manifest records {rows}",
        t.height,
    )

    # The canonical dataset the vectors were computed from.
    layout = data_layout(root=data_root)
    data = load_processed(
        ProcessedLayout.for_subset(layout.processed, DATASET_NAME, art.subset)
    )
    check(
        "dataset_version_matches",
        data.dataset_version == art.dataset_version,
        f"embeddings were exported from {art.dataset_version} but the processed "
        f"dataset is {data.dataset_version}",
    )
    known = set(data.plays["id"].to_list())
    unknown = [pid for pid in t["id"].to_list() if pid not in known]
    check(
        "play_ids_in_dataset",
        not unknown,
        f"{len(unknown)} play IDs are not in the processed dataset, e.g. {unknown[:3]}",
    )
    report.checks["dataset_plays"] = data.plays.height
    report.checks["coverage_of_dataset"] = round(
        t.height / max(1, data.plays.height), 6
    )

    # Split membership must match the split assignment the model was trained with.
    splits_path = layout.processed / DATASET_NAME / art.subset / "ml" / "splits.parquet"
    if splits_path.is_file():
        splits = pl.read_parquet(splits_path).select("id", "split")
        joined = t.select("id", "split").join(
            splits, on="id", how="left", suffix="_assigned"
        )
        mismatched = joined.filter(
            pl.col("split_assigned").is_null()
            | (pl.col("split") != pl.col("split_assigned"))
        ).height
        check(
            "splits_match_assignment",
            mismatched == 0,
            f"{mismatched} plays have a split different from {splits_path.name}",
        )
        info_path = splits_path.with_name("splits.json")
        if info_path.is_file():
            sv = json.loads(info_path.read_text()).get("split_version")
            check(
                "split_version_matches",
                sv == art.split_version,
                f"split version {art.split_version} != assignment {sv}",
            )
    else:
        report.notes.append(
            f"{splits_path} not found; split labels checked for values only."
        )

    # The model artifact, when present, must be the one that produced the vectors.
    model_json = (
        find_repo_root() / "artifacts" / "models" / art.model_version / "model.json"
    )
    if model_json.is_file():
        meta = json.loads(model_json.read_text())
        check(
            "model_weights_match",
            meta.get("weights_sha256") == m.get("model_weights_sha256"),
            "model.json weights sha256 differs from the embedding manifest",
        )
        check(
            "model_split_version_matches",
            meta.get("split_version") == art.split_version,
            "model split version differs from the embedding manifest",
        )
        enc = meta.get("encoder") or {}
        if "embedding_dim" in enc:
            check(
                "model_embedding_dim_matches",
                int(enc["embedding_dim"]) == dim,
                f"model embedding_dim {enc['embedding_dim']} != vectors {dim}",
            )
    else:
        report.notes.append(
            f"{model_json} not found; model provenance comes from the manifest only."
        )

    if problems:
        raise EmbeddingArtifactError(
            f"{art.path.name} failed validation:\n  - " + "\n  - ".join(problems)
        )
    return report


def cosine_reference(
    vectors: np.ndarray, pairs: int = 200_000, seed: int = 7, block: int = 1024
) -> dict[str, Any]:
    """Distribution of cosine similarity in this embedding space.

    ``random_pairs``: uniformly sampled distinct pairs (seeded). ``nearest_neighbor``:
    each play's single most similar other play (exact). Together they let a score
    be read against the space itself instead of as an absolute number.
    """
    v = vectors.astype(np.float64)
    n = len(v)
    if n < 2:
        return {
            "random_pairs": None,
            "nearest_neighbor": None,
            "mean_vector_norm": None,
        }
    rng = np.random.default_rng(seed)
    a = rng.integers(0, n, pairs)
    b = rng.integers(0, n - 1, pairs)
    b = b + (b >= a)  # distinct partner, uniform over the other n - 1 plays
    random_sims = np.einsum("ij,ij->i", v[a], v[b])
    nearest = np.empty(n)
    for start in range(0, n, block):
        sims = v[start : start + block] @ v.T
        rows = np.arange(sims.shape[0])
        sims[rows, rows + start] = -np.inf
        nearest[start : start + block] = sims.max(axis=1)

    def summary(x: np.ndarray) -> dict[str, float]:
        q = np.percentile(x, [5, 25, 50, 75, 95, 99])
        return {
            "mean": round(float(x.mean()), 4),
            "p05": round(float(q[0]), 4),
            "p25": round(float(q[1]), 4),
            "p50": round(float(q[2]), 4),
            "p75": round(float(q[3]), 4),
            "p95": round(float(q[4]), 4),
            "p99": round(float(q[5]), 4),
        }

    return {
        "random_pairs": {**summary(random_sims), "n": pairs, "seed": seed},
        "nearest_neighbor": {**summary(nearest), "n": n},
        "mean_vector_norm": round(float(np.linalg.norm(v.mean(axis=0))), 4),
    }


def search_rows(art: EmbeddingArtifact, data_root: Path | None) -> pl.DataFrame:
    """Embedding rows (``pid``, split, embedding) joined with the pre-snap context
    columns stored for filtering, in artifact row order."""
    layout = data_layout(root=data_root)
    data = load_processed(
        ProcessedLayout.for_subset(layout.processed, DATASET_NAME, art.subset)
    )
    context = data.plays.select(
        *KEY,
        "season",
        "week",
        "quarter",
        "down",
        "yards_to_go",
        pl.col("possession_team").alias("offense"),
        pl.col("defensive_team").alias("defense"),
        "offense_formation",
        (pl.col("line_of_scrimmage_x") - 10.0).alias("yards_from_own_goal"),
    )
    return (
        art.table.select("id", *KEY, "split", "embedding")
        .join(context, on=KEY, how="left", maintain_order="left")
        .rename({"id": "pid"})
    )
