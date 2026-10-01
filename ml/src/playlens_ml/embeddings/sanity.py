"""Sanity checks for exported play embeddings. Evaluation only, not retrieval.

    uv run python -m playlens_ml.embeddings.sanity --model-version
    trajectory-gnn-transformer-v1

1. Example neighbours: for a few test plays (chosen by a salted hash, not by
   inspection), exact cosine nearest neighbours in the train split, self
   excluded, printed with their metadata.
2. Label agreement@k: for every test play, the share of its k nearest train
   plays that share a label the model never saw as input (formation, receiver
   alignment, coverage, target route). Compared with k random train plays and
   with a metadata-only baseline (nearest by down, distance band, quarter, and
   field zone). Higher agreement than random means the embedding encodes
   structure correlated with that label; it is not a retrieval-quality claim.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from collections.abc import Sequence
from typing import Any

import numpy as np
import polars as pl

from ..data.artifacts import ProcessedLayout, load_processed
from ..data.bdb2026.spec import DATASET_NAME
from ..data.manifest import utc_now
from ..data.paths import data_layout, find_repo_root

LABELS = (
    "offense_formation",
    "receiver_alignment",
    "team_coverage_man_zone",
    "team_coverage_type",
    "route_of_targeted_receiver",
)
KEY = ["game_id", "play_id"]


def cosine_topk(
    queries: np.ndarray, corpus: np.ndarray, k: int, exclude: np.ndarray | None = None
) -> np.ndarray:
    """Exact search over unit vectors. ``exclude[i]`` is a corpus index to skip for
    query i (or -1)."""
    sims = queries @ corpus.T
    if exclude is not None:
        rows = np.flatnonzero(exclude >= 0)
        sims[rows, exclude[rows]] = -np.inf
    order = np.argsort(-sims, axis=1, kind="stable")
    return order[:, :k]


def situation_vectors(meta: pl.DataFrame, seed: int) -> np.ndarray:
    """Metadata-only baseline: one-hot down, distance band, quarter, field zone; tiny
    seeded jitter breaks ties."""
    band = (
        meta["yards_to_go"]
        .cut([3, 7], labels=["short", "medium", "long"], left_closed=False)
        .cast(pl.String)
    )
    zone = (meta["line_of_scrimmage_x"] // 20).cast(pl.Int64).cast(pl.String)
    parts = [meta["down"].cast(pl.String), band, meta["quarter"].cast(pl.String), zone]
    cols = []
    for p in parts:
        values = p.fill_null("?").to_numpy()
        for v in sorted(set(values)):
            cols.append((values == v).astype(np.float32))
    x = np.stack(cols, axis=1)
    x += np.random.default_rng(seed).normal(0, 1e-3, x.shape).astype(np.float32)
    out: np.ndarray = x / np.linalg.norm(x, axis=1, keepdims=True)
    return out


def agreement(
    labels: np.ndarray, query_labels: np.ndarray, neighbours: np.ndarray
) -> tuple[float, int]:
    """Mean share of neighbours whose label equals the query's (null labels skipped)."""
    shares = []
    for q, nb in zip(query_labels, neighbours, strict=True):
        if q is None:
            continue
        nl = [labels[j] for j in nb if labels[j] is not None]
        if nl:
            shares.append(sum(v == q for v in nl) / len(nl))
    return (float(np.mean(shares)) if shares else float("nan")), len(shares)


def run_sanity(
    model_version: str,
    subset: str = "full",
    k: int = 10,
    n_examples: int = 5,
    seed: int = 7,
) -> dict[str, Any]:
    layout = data_layout()
    processed_layout = ProcessedLayout.for_subset(
        layout.processed, DATASET_NAME, subset
    )
    table = pl.read_parquet(
        processed_layout.root / "embeddings" / f"{model_version}.parquet"
    )
    data = load_processed(processed_layout)
    meta = (
        table.select("id", *KEY, "split")
        .join(
            data.plays.select(
                *KEY,
                "home_team",
                "visitor_team",
                "possession_team",
                "down",
                "yards_to_go",
                "quarter",
                "line_of_scrimmage_x",
                "offense_formation",
                "receiver_alignment",
            ),
            on=KEY,
            how="left",
            maintain_order="left",
        )
        .join(
            data.annotations.select(
                *KEY,
                "team_coverage_man_zone",
                "team_coverage_type",
                "route_of_targeted_receiver",
            ),
            on=KEY,
            how="left",
            maintain_order="left",
        )
    )
    meta = meta.join(
        data.outcomes.select(*KEY, "play_description"),
        on=KEY,
        how="left",
        maintain_order="left",
    )
    emb = np.asarray(table["embedding"].to_numpy(), dtype=np.float32)
    split = meta["split"].to_numpy()
    q_idx = np.flatnonzero(split == "test")
    c_idx = np.flatnonzero(split == "train")

    learned = c_idx[cosine_topk(emb[q_idx], emb[c_idx], k)]
    situ = situation_vectors(meta, seed)
    metadata_nn = c_idx[cosine_topk(situ[q_idx], situ[c_idx], k)]
    rng = np.random.default_rng(seed)
    random_nn = rng.choice(c_idx, size=(len(q_idx), k), replace=True)

    rows = []
    for label in LABELS:
        values = np.array(meta[label].to_list(), dtype=object)
        row: dict[str, Any] = {"label": label}
        for name, nn in (
            ("learned", learned),
            ("metadata_baseline", metadata_nn),
            ("random", random_nn),
        ):
            share, n = agreement(values, values[q_idx], nn)
            row[name] = round(share, 4)
            row["queries"] = n
        rows.append(row)

    # Example neighbours for hash-chosen test queries, searched over the whole corpus
    # minus self.
    ids = meta["id"].to_list()
    chosen = sorted(
        q_idx, key=lambda i: hashlib.sha256(f"sanity-v1:{ids[i]}".encode()).hexdigest()
    )[:n_examples]
    nn_all = cosine_topk(emb[chosen], emb, 5, exclude=np.array(chosen))

    def describe(i: int) -> dict[str, Any]:
        r = meta.row(int(i), named=True)
        return {
            "id": r["id"],
            "split": r["split"],
            "matchup": f"{r['visitor_team']} at {r['home_team']}",
            "offense": r["possession_team"],
            "down": r["down"],
            "yards_to_go": r["yards_to_go"],
            "formation": r["offense_formation"],
            "alignment": r["receiver_alignment"],
            "coverage": r["team_coverage_type"],
            "route": r["route_of_targeted_receiver"],
            "description": (r["play_description"] or "")[:140],
        }

    examples = []
    for q, nb in zip(chosen, nn_all, strict=True):
        examples.append(
            {
                "query": describe(int(q)),
                "neighbours": [
                    {**describe(j), "cosine": round(float(emb[q] @ emb[j]), 4)}
                    for j in nb
                ],
                "self_excluded": int(q) not in set(nb.tolist()),
            }
        )
    return {
        "model_version": model_version,
        "k": k,
        "queries": "test split plays; corpus = train split",
        "label_agreement_at_k": rows,
        "examples": examples,
        "generated_at": utc_now(),
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--model-version", required=True)
    parser.add_argument("--subset", default="full")
    parser.add_argument("--k", type=int, default=10)
    args = parser.parse_args(argv)
    report = run_sanity(args.model_version, args.subset, args.k)
    out = (
        find_repo_root()
        / "artifacts"
        / "evaluation"
        / "embeddings"
        / args.model_version
        / "sanity.json"
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    print(f"label agreement@{args.k} (test queries vs train corpus):", file=sys.stderr)
    for r in report["label_agreement_at_k"]:
        print(
            f"  {r['label']:<28} learned {r['learned']:.3f}  metadata "
            f"{r['metadata_baseline']:.3f}  "
            f"random {r['random']:.3f}  (n={r['queries']})",
            file=sys.stderr,
        )
    print(f"-> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
