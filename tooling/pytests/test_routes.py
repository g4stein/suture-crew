"""backend/routes.py: the read routes the gateway serves under /api/apps/suture-crew/, called the way the gateway's
RouteRegistry calls them (``await handler(request, ctx)``)."""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, Optional

import pytest
from aiohttp import web
from aiohttp.test_utils import make_mocked_request

from backend import ledger_mcp as L
from backend import routes as R

NOW = datetime(2026, 11, 21, 12, 0, 0, tzinfo=timezone.utc)


@dataclass
class Ctx:
    """The one gateway AppContext member the routes read."""

    data_dir: Path


def call(path: str, ctx: Ctx, match: Optional[Dict[str, str]] = None) -> web.Response:
    routes = {(r.method, r.path): r for r in R.register_routes(ctx)}
    pattern = "/reports/{record_id}" if match is not None else path
    req = make_mocked_request("GET", f"/api/apps/suture-crew{path}", match_info=match or {})
    resp = asyncio.run(routes[("GET", pattern)].handler(req, ctx))
    assert isinstance(resp, web.Response)
    return resp


def body(resp: web.Response) -> Dict[str, object]:
    assert resp.text is not None
    value = json.loads(resp.text)
    assert isinstance(value, dict)
    return value


def test_registered_routes() -> None:
    routes = R.register_routes(Ctx(Path("/unused")))
    assert [(r.method, r.path) for r in routes] == [("GET", "/status"), ("GET", "/reports"), ("GET", "/reports/{record_id}")]
    assert all(asyncio.iscoroutinefunction(r.handler) for r in routes)


def test_routes_read_what_the_mcp_server_wrote(audit_report: Dict[str, object], patch_report: Dict[str, object], tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    # No env override: the routes use ctx.data_dir, the same directory the MCP process derives from its own location.
    monkeypatch.delenv("SUTURE_CREW_DATA_DIR", raising=False)
    ctx = Ctx(tmp_path / "data")
    a = L.build_record(audit_report, "sample", "invariant-adversary", None, NOW)
    p = L.build_record(patch_report, "sample", "formula-surgeon", None, NOW.replace(minute=5))
    L.save_record(ctx.data_dir, a)
    L.save_record(ctx.data_dir, p)

    listing = body(call("/reports", ctx))
    assert [r["id"] for r in listing["records"]] == [p["id"], a["id"]]  # newest first
    status = body(call("/status", ctx))
    assert status["records"] == 2 and status["counts"] == {"workbooks": 0, "audit": 1, "patch": 1}

    one = call(f"/reports/{a['id']}", ctx, {"record_id": a["id"]})
    assert one.status == 200 and body(one) == a


def test_env_override_applies_to_routes(audit_report: Dict[str, object], data_dir: Path, tmp_path: Path) -> None:
    rec = L.build_record(audit_report, "sample", None, None, NOW)
    L.save_record(data_dir, rec)
    listing = body(call("/reports", Ctx(tmp_path / "ignored")))
    assert [r["id"] for r in listing["records"]] == [rec["id"]]


@pytest.mark.parametrize("bad", ["..", "../../etc/passwd", "%2e%2e", "20261121T120000Z-audit-0123456789ab.json", "x"])
def test_invalid_ids_are_400(bad: str, data_dir: Path) -> None:
    resp = call(f"/reports/{bad}", Ctx(data_dir), {"record_id": bad})
    assert resp.status == 400 and body(resp)["code"] == "invalid_record_id"


def test_missing_record_is_404(data_dir: Path) -> None:
    rid = L.new_record_id("audit", NOW)
    resp = call(f"/reports/{rid}", Ctx(data_dir), {"record_id": rid})
    assert resp.status == 404 and body(resp)["code"] == "record_not_found"


def test_empty_ledger(data_dir: Path) -> None:
    assert body(call("/reports", Ctx(data_dir))) == {"records": []}
    status = body(call("/status", Ctx(data_dir)))
    assert status["ledger"] == "empty" and status["records"] == 0 and status["latest"] is None
