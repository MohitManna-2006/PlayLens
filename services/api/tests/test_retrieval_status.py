"""The developer status CLI (`make db-status`) without a database."""

import pytest
from playlens_api.retrieval import status


def test_unreachable_database_is_exit_code_1(
    capsys: pytest.CaptureFixture[str],
) -> None:
    # Nothing listens on port 1.
    code = status.main(
        ["--database-url", "postgresql://nobody:secret@127.0.0.1:1/none", "--brief"]
    )
    out = capsys.readouterr().out
    assert code == status.UNREACHABLE == 1
    assert out.startswith("database unreachable at postgresql://nobody:***@127.0.0.1:1")
    assert "secret" not in out
