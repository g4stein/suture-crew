"""Shared fixtures for the backend tests: the repository on sys.path and the real Suture reports captured by
``tooling/scripts/prove-sample.mjs --write-fixtures``."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Dict

import pytest

REPO = Path(__file__).resolve().parents[2]
FIXTURES = REPO / "tooling" / "fixtures"
if str(REPO) not in sys.path:
    sys.path.insert(0, str(REPO))


def _load(name: str) -> Dict[str, object]:
    value = json.loads((FIXTURES / name).read_text(encoding="utf-8"))
    assert isinstance(value, dict)
    return value


@pytest.fixture()
def audit_report() -> Dict[str, object]:
    return _load("audit.json")


@pytest.fixture()
def patch_report() -> Dict[str, object]:
    return _load("verify-patch.json")


@pytest.fixture()
def workbooks_report() -> Dict[str, object]:
    return _load("workbooks.json")


@pytest.fixture()
def data_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """An isolated ledger directory, selected through the same env override both processes read."""
    target = tmp_path / "data"
    monkeypatch.setenv("SUTURE_CREW_DATA_DIR", str(target))
    return target
