"""MLflow experiment tracking (Masterbrain §33), local by default.

The default store is a SQLite database and artifact folder under <repo>/mlruns
(Git-ignored). Browse it with:

    uv run mlflow ui --backend-store-uri sqlite:///mlruns/mlflow.db
"""

from __future__ import annotations

import logging
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any

from ..data.paths import find_repo_root

log = logging.getLogger("playlens.ml.tracking")


def default_tracking_uri() -> tuple[str, str]:
    root = find_repo_root() / "mlruns"
    root.mkdir(exist_ok=True)
    return f"sqlite:///{root / 'mlflow.db'}", (root / "artifacts").as_uri()


def flatten(prefix: str, value: Any, out: dict[str, Any]) -> dict[str, Any]:
    if isinstance(value, Mapping):
        for k, v in value.items():
            flatten(f"{prefix}.{k}" if prefix else str(k), v, out)
    else:
        out[prefix] = value
    return out


class RunTracker:
    """Thin wrapper so training code runs identically with tracking disabled."""

    def __init__(
        self, enabled: bool, experiment: str, run_name: str, tracking_uri: str | None
    ) -> None:
        self.enabled = enabled
        self.run_id: str | None = None
        if not enabled:
            return
        os.environ.setdefault("MLFLOW_DISABLE_AGENT_HINT", "1")
        import mlflow

        uri, artifact_root = default_tracking_uri()
        mlflow.set_tracking_uri(tracking_uri or uri)
        if mlflow.get_experiment_by_name(experiment) is None:
            mlflow.create_experiment(
                experiment, artifact_location=None if tracking_uri else artifact_root
            )
        mlflow.set_experiment(experiment)
        self._mlflow = mlflow
        self.run_id = mlflow.start_run(run_name=run_name).info.run_id

    def params(self, params: Mapping[str, Any]) -> None:
        if self.enabled:
            flat = {k: str(v)[:500] for k, v in flatten("", params, {}).items()}
            self._mlflow.log_params(flat)

    def metrics(self, metrics: Mapping[str, float], step: int | None = None) -> None:
        if self.enabled:
            self._mlflow.log_metrics(
                {k: float(v) for k, v in metrics.items()}, step=step
            )

    def tags(self, tags: Mapping[str, str]) -> None:
        if self.enabled:
            self._mlflow.set_tags(dict(tags))

    def artifacts(self, path: Path, artifact_path: str | None = None) -> None:
        if self.enabled:
            if path.is_dir():
                self._mlflow.log_artifacts(str(path), artifact_path)
            else:
                self._mlflow.log_artifact(str(path), artifact_path)

    def end(self, status: str = "FINISHED") -> None:
        if self.enabled:
            self._mlflow.end_run(status=status)
