"""Deployable trajectory-model artifact.

    artifacts/models/<model_version>/
        model.pt     state_dict (weights and normalization buffers)
        model.json   everything else needed to rebuild and describe the model:
                     architecture config, feature schema, vocabularies,
                     normalization statistics, window/horizon, coordinate
                     convention, dataset and split versions, metrics, hashes

Inference never needs the training data. Artifacts are Git-ignored: weights
are derived from licensed competition data and reproducible from the
training command, config, and dataset manifest.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import torch

from ..data.artifacts import sha256_file
from ..data.coordinates import COORDINATE_DESCRIPTION, COORDINATE_SYSTEM
from ..data.paths import find_repo_root
from ..features import spec as feature_spec
from ..features.encoding import Encoders
from ..models.encoder import EncoderConfig
from ..models.trajectory import HeadConfig, TrajectoryModel

ARTIFACT_FORMAT = "playlens-trajectory-artifact-v1"
WEIGHTS = "model.pt"
METADATA = "model.json"


class ArtifactError(RuntimeError):
    """The model artifact is missing, incompatible, or corrupt."""


def default_models_dir() -> Path:
    return find_repo_root() / "artifacts" / "models"


@dataclass
class TrajectoryArtifact:
    model: TrajectoryModel
    encoders: Encoders
    metadata: dict[str, Any]
    path: Path | None = None

    @property
    def model_version(self) -> str:
        return str(self.metadata["model_version"])

    @property
    def window(self) -> int:
        return int(self.model.encoder_cfg.window)

    @property
    def horizon(self) -> int:
        return int(self.model.head_cfg.horizon)

    def save(self, directory: Path) -> Path:
        directory.mkdir(parents=True, exist_ok=True)
        weights = directory / WEIGHTS
        torch.save(self.model.state_dict(), weights)
        meta = {
            **self.metadata,
            "format": ARTIFACT_FORMAT,
            "window": self.window,
            "horizon": self.horizon,
            "encoder": self.model.encoder_cfg.to_json(),
            "head": self.model.head_cfg.to_json(),
            "encoders": self.encoders.to_json(),
            "features": feature_spec.describe(),
            "coordinate_system": COORDINATE_SYSTEM,
            "coordinate_description": COORDINATE_DESCRIPTION,
            "frame_rate_hz": feature_spec.FRAME_RATE_HZ,
            "weights_sha256": sha256_file(weights),
            "weights_bytes": weights.stat().st_size,
        }
        (directory / METADATA).write_text(
            json.dumps(meta, indent=2, sort_keys=True, default=str) + "\n"
        )
        self.metadata = meta
        self.path = directory
        return directory

    @classmethod
    def load(
        cls, directory: Path, device: torch.device | str = "cpu"
    ) -> TrajectoryArtifact:
        meta_path, weights = directory / METADATA, directory / WEIGHTS
        if not meta_path.is_file() or not weights.is_file():
            raise ArtifactError(f"No trajectory model artifact at {directory}.")
        meta = json.loads(meta_path.read_text())
        if meta.get("format") != ARTIFACT_FORMAT:
            raise ArtifactError(
                f"{directory} has format {meta.get('format')!r}; expected "
                f"{ARTIFACT_FORMAT}."
            )
        if (
            meta["features"]["feature_schema_version"]
            != feature_spec.FEATURE_SCHEMA_VERSION
        ):
            raise ArtifactError(
                f"{directory} was trained with feature schema "
                f"v{meta['features']['feature_schema_version']}; "
                f"this code builds v{feature_spec.FEATURE_SCHEMA_VERSION}. Retrain "
                "or check out the matching code."
            )
        if sha256_file(weights) != meta["weights_sha256"]:
            raise ArtifactError(f"{weights} does not match the checksum in {METADATA}.")
        encoders = Encoders.from_json(meta["encoders"])
        model = TrajectoryModel(
            EncoderConfig(**meta["encoder"]),
            HeadConfig(**meta["head"]),
            list(encoders.mean),
            list(encoders.std),
        )
        model.load_state_dict(
            torch.load(weights, map_location="cpu", weights_only=True)
        )
        model.to(device).eval()
        return cls(model=model, encoders=encoders, metadata=meta, path=directory)
