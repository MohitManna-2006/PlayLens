"""The committed contract artifacts must match what the API code produces.

The web test suite parses packages/contracts/examples with its zod schemas, so
together these tests check Pydantic <-> TypeScript agreement end to end.
"""

from playlens_api.contract_examples import build, contracts_dir, render


def test_committed_contract_artifacts_are_current() -> None:
    stale = []
    for name, payload in build().items():
        path = contracts_dir() / name
        if not path.is_file() or path.read_text() != render(payload):
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
