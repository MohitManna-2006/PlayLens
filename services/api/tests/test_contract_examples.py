"""The committed contract artifacts must match what the API code produces.

The web test suite parses packages/contracts/examples with its zod schemas, so
together these tests check Pydantic <-> TypeScript agreement end to end.
"""

import json
from typing import Any

import pytest
from playlens_api.contract_examples import build, contracts_dir


def _same(a: Any, b: Any, tol: float = 2e-3) -> bool:
    """Structural equality; model-derived floats may differ slightly across CPUs."""
    if isinstance(a, dict) and isinstance(b, dict):
        return a.keys() == b.keys() and all(_same(a[k], b[k], tol) for k in a)
    if isinstance(a, list) and isinstance(b, list):
        return len(a) == len(b) and all(
            _same(x, y, tol) for x, y in zip(a, b, strict=True)
        )
    if isinstance(a, float) or isinstance(b, float):
        return (
            isinstance(a, int | float)
            and isinstance(b, int | float)
            and a == pytest.approx(b, abs=tol, rel=tol)
        )
    return bool(a == b)


@pytest.fixture(scope="module")
def built() -> dict[str, Any]:
    return build()


def test_committed_contract_artifacts_are_current(built: dict[str, Any]) -> None:
    stale = []
    for name, payload in built.items():
        path = contracts_dir() / name
        if not path.is_file() or not _same(json.loads(path.read_text()), payload):
            stale.append(name)
    assert not stale, f"Run `pnpm contracts:generate`; stale: {stale}"


def test_examples_cover_every_play_resource() -> None:
    names = set(build())
    for resource in (
        "play-page",
        "play-detail",
        "frames",
        "future",
        "facets",
        "dataset",
        "models",
    ):
        assert f"examples/{resource}.json" in names
