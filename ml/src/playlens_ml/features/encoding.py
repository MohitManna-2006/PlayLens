"""Categorical vocabularies and numeric standardization, fitted on the train split
only."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np

from .samples import SampleSet
from .spec import CATEGORICAL_FEATURES, NUMERIC_FEATURES

UNK = "<unk>"
STD_FLOOR = 1e-3


@dataclass(frozen=True)
class Vocab:
    """Index 0 is reserved for values never seen in training (and empty strings)."""

    values: tuple[str, ...]

    def encode(self, raw: np.ndarray) -> np.ndarray:
        lookup = {v: i for i, v in enumerate(self.values)}
        return np.array([lookup.get(str(v), 0) for v in raw], dtype=np.int64)

    def __len__(self) -> int:
        return len(self.values)


@dataclass(frozen=True)
class Encoders:
    vocabs: dict[str, Vocab]
    mean: tuple[float, ...]
    std: tuple[float, ...]

    def categorical(self, samples: SampleSet) -> np.ndarray:
        """[n_players, len(CATEGORICAL_FEATURES)] int64 codes."""
        columns = {
            "side": samples.side,
            "position": samples.position,
            "role": samples.role,
        }
        return np.stack(
            [self.vocabs[name].encode(columns[name]) for name in CATEGORICAL_FEATURES],
            axis=1,
        )

    def to_json(self) -> dict[str, Any]:
        return {
            "vocabs": {k: list(v.values) for k, v in self.vocabs.items()},
            "numeric_features": list(NUMERIC_FEATURES),
            "mean": list(self.mean),
            "std": list(self.std),
        }

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> Encoders:
        if list(data["numeric_features"]) != list(NUMERIC_FEATURES):
            raise ValueError(
                "Saved numeric features differ from this code's feature schema."
            )
        return cls(
            vocabs={k: Vocab(tuple(v)) for k, v in data["vocabs"].items()},
            mean=tuple(float(x) for x in data["mean"]),
            std=tuple(float(x) for x in data["std"]),
        )


def fit_encoders(train: SampleSet) -> Encoders:
    """Vocabularies and per-feature mean/std from TRAIN players' observed frames
    only."""
    columns = {"side": train.side, "position": train.position, "role": train.role}
    vocabs = {
        name: Vocab((UNK, *sorted({str(v) for v in columns[name] if str(v)})))
        for name in CATEGORICAL_FEATURES
    }
    values = train.numeric[train.mask]  # [n_valid_frames, F]
    if len(values) == 0:
        raise ValueError(
            "Cannot fit normalization: the train split has no observed frames."
        )
    mean = values.mean(axis=0, dtype=np.float64)
    std = np.maximum(values.std(axis=0, dtype=np.float64), STD_FLOOR)
    return Encoders(vocabs=vocabs, mean=tuple(mean.tolist()), std=tuple(std.tolist()))
