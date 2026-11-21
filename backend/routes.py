"""Suture Crew read routes, registered in the Kiro Crew gateway through ``backend.hooks.routes``.

Served under ``/api/apps/suture-crew/``: the dashboard page reads the ledger that ``ledger_mcp.py`` writes. Every route
is read-only, and file access runs off the gateway's event loop.
"""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
from pathlib import Path
from typing import Awaitable, Callable, Dict, List, Optional, Protocol

from aiohttp import web

from .ledger_mcp import (
    MAX_RECORDS,
    ReportError,
    is_record_id,
    list_summaries,
    load_record,
    reports_dir,
    resolve_data_dir,
)


class AppContext(Protocol):
    """The part of the gateway's app context these routes read."""

    data_dir: Path


Handler = Callable[[web.Request, AppContext], Awaitable[web.StreamResponse]]


@dataclass(frozen=True)
class Route:
    method: str
    path: str
    handler: Handler


def _data_dir(ctx: AppContext) -> Path:
    return resolve_data_dir(Path(ctx.data_dir))


def _status(data_dir: Path) -> Dict[str, object]:
    summaries = list_summaries(data_dir)
    counts: Dict[str, int] = {"workbooks": 0, "audit": 0, "patch": 0}
    for s in summaries:
        counts[str(s["kind"])] += 1
    latest: Optional[str] = str(summaries[0]["recordedAt"]) if summaries else None
    return {"ledger": "ok" if reports_dir(data_dir).is_dir() else "empty", "records": len(summaries), "counts": counts, "latest": latest, "limit": MAX_RECORDS}


async def get_status(request: web.Request, ctx: AppContext) -> web.Response:
    return web.json_response(await asyncio.to_thread(_status, _data_dir(ctx)))


async def list_reports(request: web.Request, ctx: AppContext) -> web.Response:
    summaries = await asyncio.to_thread(list_summaries, _data_dir(ctx))
    return web.json_response({"records": summaries})


async def get_report(request: web.Request, ctx: AppContext) -> web.Response:
    record_id = request.match_info.get("record_id", "")
    if not is_record_id(record_id):
        return web.json_response({"error": "invalid record id", "code": "invalid_record_id"}, status=400)
    try:
        record = await asyncio.to_thread(load_record, _data_dir(ctx), record_id)
    except ReportError:
        return web.json_response({"error": "invalid record id", "code": "invalid_record_id"}, status=400)
    if record is None:
        return web.json_response({"error": "record not found", "code": "record_not_found"}, status=404)
    return web.json_response(record)


def register_routes(ctx: AppContext) -> List[Route]:
    return [
        Route("GET", "/status", get_status),
        Route("GET", "/reports", list_reports),
        Route("GET", "/reports/{record_id}", get_report),
    ]
