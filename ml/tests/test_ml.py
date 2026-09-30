import duckdb
import lightgbm
import mlflow
import polars
import sklearn  # type: ignore
import torch


def test_imports() -> None:
    assert torch is not None
    assert polars is not None
    assert duckdb is not None
    assert sklearn is not None
    assert lightgbm is not None
    assert mlflow is not None
