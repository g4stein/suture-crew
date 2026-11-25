"""backend/ledger_mcp.py: the record store, report validation, and the stdio MCP protocol (driven as a real process)."""
from __future__ import annotations

import copy
import json
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Dict, List, Optional

import pytest

from backend import ledger_mcp as L

from conftest import REPO

LEDGER = REPO / "backend" / "ledger_mcp.py"
NOW = datetime(2026, 11, 21, 12, 0, 0, tzinfo=timezone.utc)


def run_server(lines: List[str], data_dir: Path) -> List[Dict[str, object]]:
    """Run the real server process over stdio and return every reply line."""
    env = {**os.environ, "SUTURE_CREW_DATA_DIR": str(data_dir)}
    proc = subprocess.run([sys.executable, str(LEDGER)], input="\n".join(lines) + "\n", capture_output=True, text=True, env=env, timeout=60, check=True)
    return [json.loads(line) for line in proc.stdout.splitlines() if line.strip()]


def rpc(method: str, msg_id: Optional[int], params: Optional[Dict[str, object]] = None) -> str:
    msg: Dict[str, object] = {"jsonrpc": "2.0", "method": method}
    if msg_id is not None:
        msg["id"] = msg_id
    if params is not None:
        msg["params"] = params
    return json.dumps(msg)


# -- data directory -----------------------------------------------------------------------------------------------


def test_default_data_dir_is_app_root_data(monkeypatch: pytest.MonkeyPatch) -> None:
    # Kiro Crew's hooks receive app_dir(name) / "data" as ctx.data_dir; the MCP process derives the same path.
    monkeypatch.delenv("SUTURE_CREW_DATA_DIR", raising=False)
    assert L.default_data_dir() == REPO / "data"
    assert L.resolve_data_dir() == REPO / "data"
    assert L.resolve_data_dir(Path("/srv/crew/apps/suture-crew/data")) == Path("/srv/crew/apps/suture-crew/data")


def test_env_override_wins(data_dir: Path) -> None:
    assert L.resolve_data_dir() == data_dir
    assert L.resolve_data_dir(Path("/elsewhere")) == data_dir


# -- record ids ---------------------------------------------------------------------------------------------------


@pytest.mark.parametrize("bad", ["", "..", "../x", "20261121T120000Z-audit-../../etc", "20261121T120000Z-audit-ABCDEF123456",
                                 "20261121T120000Z-other-0123456789ab", "20261121T120000Z-audit-0123456789ab/../x",
                                 "20261121T120000Z-audit-0123456789ab.json", " 20261121T120000Z-audit-0123456789ab"])
def test_record_path_refuses_anything_but_generated_ids(bad: str, tmp_path: Path) -> None:
    assert not L.is_record_id(bad)
    with pytest.raises(L.ReportError):
        L.record_path(tmp_path, bad)


def test_generated_ids_match_the_pattern() -> None:
    for kind in ("workbooks", "audit", "patch"):
        assert L.is_record_id(L.new_record_id(kind, NOW))


# -- validation ---------------------------------------------------------------------------------------------------


def test_real_reports_validate(audit_report: Dict[str, object], patch_report: Dict[str, object], workbooks_report: Dict[str, object]) -> None:
    assert L.validate_report(audit_report) == "audit"
    assert L.validate_report(patch_report) == "patch"
    assert L.validate_report(workbooks_report) == "workbooks"


@pytest.mark.parametrize("mutate, field", [
    (lambda r: r.update(format="suture.other"), "$.format"),
    (lambda r: r.update(version=2), "$.version"),
    (lambda r: r.update(verdict="maybe"), "$.verdict"),
    (lambda r: r.update(tier2="none"), "$.tier2"),
    (lambda r: r["workbook"].pop("hash"), "$.workbook.hash"),
    (lambda r: r["lineage"][0].update(dialect="vb"), "$.lineage[0].dialect"),
    (lambda r: r["replay"]["artifact"].update(format="x"), "$.replay.artifact.format"),
])
def test_invalid_audit_reports_name_the_field(audit_report: Dict[str, object], mutate: Callable[[Dict[str, Dict]], object], field: str) -> None:
    r = copy.deepcopy(audit_report)
    mutate(r)
    with pytest.raises(L.ReportError) as exc:
        L.validate_report(r)
    assert str(exc.value).startswith(field)


def test_invalid_patch_report(patch_report: Dict[str, object]) -> None:
    r = copy.deepcopy(patch_report)
    r["regressions"] = [{"kind": "masked", "cell": "Quote!B4"}]
    with pytest.raises(L.ReportError, match=r"\$\.regressions\[0\]"):
        L.validate_report(r)


def test_replay_url_only_for_well_formed_fragments(audit_report: Dict[str, object]) -> None:
    replay = audit_report["replay"]
    assert isinstance(replay, dict)
    assert L.replay_url(audit_report) == "https://suture-nu.vercel.app/#" + str(replay["fragment"])
    for frag in (None, "replay=v2.abc", "replay=v1.abc\"onload", "replay=v1." + "a" * 8192):
        r = copy.deepcopy(audit_report)
        r_replay = r["replay"]
        assert isinstance(r_replay, dict)
        r_replay["fragment"] = frag
        assert L.replay_url(r) is None


# -- store --------------------------------------------------------------------------------------------------------


def test_save_and_load_round_trip(audit_report: Dict[str, object], data_dir: Path) -> None:
    record = L.build_record(audit_report, "sample", "invariant-adversary", "nightly", NOW)
    path = L.save_record(data_dir, record)
    assert path.parent == data_dir / "reports"
    assert path.stat().st_mode & 0o077 == 0
    assert L.load_record(data_dir, record["id"]) == record
    assert [s["id"] for s in L.list_summaries(data_dir)] == [record["id"]]
    assert sorted(os.listdir(data_dir / "reports")) == [f"{record['id']}.json"]


def test_load_skips_corrupt_and_foreign_files(audit_report: Dict[str, object], data_dir: Path) -> None:
    good = L.build_record(audit_report, "sample", None, None, NOW)
    L.save_record(data_dir, good)
    reports = data_dir / "reports"
    half = L.new_record_id("audit", NOW)
    (reports / f"{half}.json").write_text('{"format": "suture-crew.rec', encoding="utf-8")
    (reports / f".{half}.json.tmp-1-abcd").write_text("{}", encoding="utf-8")
    (reports / "notes.json").write_text("{}", encoding="utf-8")
    assert L.load_record(data_dir, half) is None
    assert [s["id"] for s in L.list_summaries(data_dir)] == [good["id"]]


def test_pruning_keeps_the_newest(audit_report: Dict[str, object], data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(L, "MAX_RECORDS", 3)
    ids = []
    for minute in range(5):
        rec = L.build_record(audit_report, "sample", None, None, NOW.replace(minute=minute))
        L.save_record(data_dir, rec)
        ids.append(rec["id"])
    assert [s["id"] for s in L.list_summaries(data_dir)] == list(reversed(ids))[:3]


def test_records_from_the_same_second_list_newest_first(audit_report: Dict[str, object], patch_report: Dict[str, object],
                                                         workbooks_report: Dict[str, object], data_dir: Path,
                                                         monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(L, "_last_stamp_us", 0)
    # Same `now` for all three, and kinds whose names sort the other way round, so only the stamp can order them.
    ids = []
    for report in (workbooks_report, audit_report, patch_report):
        rec = L.build_record(report, "sample", None, None, NOW)
        assert rec["recordedAt"] == "2026-11-21T12:00:00Z"
        L.save_record(data_dir, rec)
        ids.append(rec["id"])
    assert [s["id"] for s in L.list_summaries(data_dir)] == list(reversed(ids))


def test_ids_from_earlier_builds_still_load_and_sort_oldest_in_their_second(audit_report: Dict[str, object], data_dir: Path,
                                                                           monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(L, "_last_stamp_us", 0)
    legacy = L.build_record(audit_report, "sample", None, None, NOW)
    legacy["id"] = "20261121T120000Z-audit-0123456789ab"
    L.save_record(data_dir, legacy)
    current = L.build_record(audit_report, "sample", None, None, NOW)
    L.save_record(data_dir, current)
    older = L.build_record(audit_report, "sample", None, None, NOW - timedelta(seconds=1))
    assert L.is_record_id(legacy["id"]) and L.load_record(data_dir, legacy["id"]) == legacy
    assert current["id"].startswith("20261121T120000000")
    assert [s["id"] for s in L.list_summaries(data_dir)] == [current["id"], legacy["id"]]
    # A clock that steps back still yields a later stamp in this process, so creation order holds.
    L.save_record(data_dir, older)
    assert L.list_summaries(data_dir)[0]["id"] == older["id"]


def test_failed_write_leaves_no_temporary_file(audit_report: Dict[str, object], data_dir: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    record = L.build_record(audit_report, "sample", None, None, NOW)

    def boom(src: object, dst: object) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(L.os, "replace", boom)
    with pytest.raises(OSError):
        L.save_record(data_dir, record)
    assert os.listdir(data_dir / "reports") == []


def test_build_record_rejects_bad_metadata(audit_report: Dict[str, object]) -> None:
    with pytest.raises(L.ReportError, match="source"):
        L.build_record(audit_report, "remote", None, None, NOW)
    with pytest.raises(L.ReportError, match="agent"):
        L.build_record(audit_report, "sample", "other-agent", None, NOW)
    with pytest.raises(L.ReportError, match="note"):
        L.build_record(audit_report, "sample", None, "x" * 501, NOW)


def test_summaries(audit_report: Dict[str, object], patch_report: Dict[str, object], workbooks_report: Dict[str, object]) -> None:
    a = L.summarize(L.build_record(audit_report, "sample", None, None, NOW))
    assert (a["kind"], a["status"], a["detail"]) == ("audit", "violated", "net-price-positive")
    assert a["replayUrl"] is not None
    p = L.summarize(L.build_record(patch_report, "sample", None, None, NOW))
    assert (p["kind"], p["status"], p["detail"]) == ("patch", "verified", "0 regression(s)")
    w = L.summarize(L.build_record(workbooks_report, "workspace", None, None, NOW))
    assert (w["kind"], w["workbook"], w["status"]) == ("workbooks", None, "1 file(s)")


# -- MCP protocol (real process) ----------------------------------------------------------------------------------


def test_session_handshake_list_and_call(audit_report: Dict[str, object], data_dir: Path) -> None:
    replies = run_server([
        rpc("initialize", 1, {"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}}),
        rpc("notifications/initialized", None),
        rpc("tools/list", 2),
        rpc("tools/call", 3, {"name": "suture_crew_record_audit", "arguments": {"report": audit_report, "source": "sample", "agent": "invariant-adversary"}}),
        rpc("ping", 4),
    ], data_dir)
    assert [r["id"] for r in replies] == [1, 2, 3, 4]  # the notification gets no reply
    init = replies[0]["result"]
    assert init["protocolVersion"] == "2025-06-18"
    assert init["serverInfo"] == {"name": "suture-crew-ledger", "version": "1.0.0"}
    assert init["capabilities"] == {"tools": {"listChanged": False}}
    tools = replies[1]["result"]["tools"]
    assert [t["name"] for t in tools] == ["suture_crew_record_audit"]
    assert tools[0]["inputSchema"]["required"] == ["report", "source"]
    call = replies[2]["result"]
    assert "isError" not in call
    assert call["structuredContent"]["recorded"] is True
    assert call["structuredContent"]["status"] == "violated"
    assert replies[3]["result"] == {}
    stored = os.listdir(data_dir / "reports")
    assert stored == [f"{call['structuredContent']['id']}.json"]


def test_unknown_protocol_version_gets_latest(data_dir: Path) -> None:
    replies = run_server([rpc("initialize", 1, {"protocolVersion": "1999-01-01", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}})], data_dir)
    assert replies[0]["result"]["protocolVersion"] == "2025-11-25"


def test_stateless_discover_and_call(patch_report: Dict[str, object], data_dir: Path) -> None:
    meta = {"io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {}}
    replies = run_server([
        rpc("server/discover", 1, {"_meta": meta}),
        rpc("tools/call", 2, {"_meta": meta, "name": "suture_crew_record_audit", "arguments": {"report": patch_report, "source": "workspace"}}),
    ], data_dir)
    discover = replies[0]["result"]
    assert discover["supportedVersions"][0] == "2026-07-28"
    assert discover["resultType"] == "complete"
    assert discover["_meta"]["io.modelcontextprotocol/serverInfo"]["name"] == "suture-crew-ledger"
    assert replies[1]["result"]["structuredContent"]["status"] == "verified"


def test_errors(data_dir: Path) -> None:
    replies = run_server([
        "{not json",
        json.dumps([{"jsonrpc": "2.0", "id": 1, "method": "ping"}]),
        rpc("resources/list", 2),
        rpc("tools/call", 3, {"name": "suture_run_audit", "arguments": {}}),
        rpc("tools/call", 4, {"name": "suture_crew_record_audit", "arguments": {"report": {"format": "suture.audit", "version": 1}, "source": "sample"}}),
        rpc("tools/call", 5, {"name": "suture_crew_record_audit", "arguments": {"report": "{]", "source": "sample"}}),
        rpc("tools/call", 6, {"name": "suture_crew_record_audit", "arguments": {"report": {}, "source": "sample", "path": "../../x"}}),
        json.dumps({"jsonrpc": "2.0", "id": 7, "method": "tools/list", "params": [1]}),
    ], data_dir)
    by_id = {r["id"]: r for r in replies if r["id"] is not None}
    nulls = [r for r in replies if r["id"] is None]
    assert [r["error"]["code"] for r in nulls] == [-32700, -32600]
    assert by_id[2]["error"]["code"] == -32601
    assert by_id[3]["error"]["code"] == -32602
    assert by_id[4]["result"]["isError"] is True and "$.workbook" in by_id[4]["result"]["content"][0]["text"]
    assert by_id[5]["result"]["isError"] is True and "not valid JSON" in by_id[5]["result"]["content"][0]["text"]
    assert by_id[6]["result"]["isError"] is True and "unknown argument(s): path" in by_id[6]["result"]["content"][0]["text"]
    assert by_id[7]["error"]["code"] == -32602
    assert not (data_dir / "reports").exists()


def test_stdout_is_json_only(data_dir: Path) -> None:
    env = {**os.environ, "SUTURE_CREW_DATA_DIR": str(data_dir)}
    proc = subprocess.run([sys.executable, str(LEDGER)], input=rpc("ping", 1) + "\n", capture_output=True, text=True, env=env, timeout=60, check=True)
    assert [json.loads(x) for x in proc.stdout.splitlines()] == [{"jsonrpc": "2.0", "id": 1, "result": {}}]
    assert "serving on stdio" in proc.stderr
