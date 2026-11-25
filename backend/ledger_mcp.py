#!/usr/bin/env python3
"""Suture Crew audit ledger: a stdio MCP server plus the record store it shares with the route hooks.

Run by Kiro Crew as the app's ``ledger`` MCP server (``python3 backend/ledger_mcp.py``). It serves one tool,
``suture_crew_record_audit``, which validates a report returned by Suture's MCP tools and stores it atomically in the
app's data directory. ``backend/routes.py`` imports the store functions from this module, so the writer and the reader
resolve the same directory and apply the same record-ID rules.

Python standard library only: the file runs as its own process and is imported by in-gateway hooks, and neither path
may need third-party packages.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, TextIO, Tuple, Union

SERVER_NAME = "suture-crew-ledger"
SERVER_VERSION = "1.0.0"
TOOL_NAME = "suture_crew_record_audit"

#: Environment override for the data directory (tests, or an operator relocating the store). Both the MCP process and
#: the route hooks read it, so a single setting moves the writer and the reader together.
DATA_DIR_ENV = "SUTURE_CREW_DATA_DIR"

#: Records kept on disk; the oldest are pruned after each write.
MAX_RECORDS = 500
#: Largest report accepted, measured as compact UTF-8 JSON.
MAX_REPORT_BYTES = 2 * 1024 * 1024
MAX_NOTE_CHARS = 500
#: A replay link fragment longer than this does not fit in a URL (Suture's MAX_FRAGMENT_CHARS).
MAX_FRAGMENT_CHARS = 8192
REPLAY_BASE_URL = "https://suture-nu.vercel.app/#"

AGENTS = ("schema-archaeologist", "invariant-adversary", "formula-surgeon")
SOURCES = ("workspace", "sample")
KINDS = {"suture.workbooks": "workbooks", "suture.audit": "audit", "suture.verify-patch": "patch"}

#: ``<UTC date>T<time><microseconds>Z-<kind>-<12 hex>``. IDs from earlier builds have no microsecond digits and still load.
RECORD_ID_RE = re.compile(r"^[0-9]{8}T[0-9]{6}(?:[0-9]{6})?Z-(workbooks|audit|patch)-[0-9a-f]{12}$")
FRAGMENT_RE = re.compile(r"^replay=v1\.[A-Za-z0-9_-]+$")

LATEST_PROTOCOL = "2025-11-25"
SESSION_PROTOCOLS = ("2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05")
STATELESS_PROTOCOL = "2026-07-28"
PROTOCOL_META_KEY = "io.modelcontextprotocol/protocolVersion"
SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo"

INSTRUCTIONS = (
    "Suture Crew's audit ledger. After every suture_list_workbooks, suture_run_audit or suture_verify_patch call, pass "
    "the tool's unmodified JSON result to suture_crew_record_audit so the Suture Crew dashboard can show it."
)

Json = Union[None, bool, int, float, str, List["Json"], Dict[str, "Json"]]


# ---------------------------------------------------------------------------
# Record store
# ---------------------------------------------------------------------------


class ReportError(ValueError):
    """A report or record that fails validation; the message names the first failing field."""


def default_data_dir() -> Path:
    """``<app root>/data``: Kiro Crew's ``app_dir(name) / "data"``, the directory hooks receive as ``ctx.data_dir``."""
    return Path(__file__).absolute().parent.parent / "data"


def resolve_data_dir(default: Optional[Path] = None) -> Path:
    override = os.environ.get(DATA_DIR_ENV, "").strip()
    if override:
        return Path(override)
    return default if default is not None else default_data_dir()


def reports_dir(data_dir: Path) -> Path:
    return data_dir / "reports"


def is_record_id(value: object) -> bool:
    return isinstance(value, str) and RECORD_ID_RE.fullmatch(value) is not None


def record_path(data_dir: Path, record_id: str) -> Path:
    """The file for ``record_id``. Refuses any ID outside the generated pattern, so no input can name another path."""
    if not is_record_id(record_id):
        raise ReportError("record id is not a Suture Crew record id")
    root = reports_dir(data_dir)
    path = root / f"{record_id}.json"
    if path.parent != root:
        raise ReportError("record id is not a Suture Crew record id")
    return path


_EPOCH = datetime(1970, 1, 1, tzinfo=timezone.utc)
#: The last ID stamp this process issued, in microseconds since the epoch.
_last_stamp_us = 0


def new_record_id(kind: str, now: datetime) -> str:
    """A new record ID stamped with ``now`` (timezone-aware) to the microsecond.

    The stamp is at least one microsecond past the last one this process issued, so IDs created within the same
    microsecond, or while the clock steps back, still sort in creation order.
    """
    global _last_stamp_us
    stamp = max((now - _EPOCH) // timedelta(microseconds=1), _last_stamp_us + 1)
    _last_stamp_us = stamp
    at = _EPOCH + timedelta(microseconds=stamp)
    return f"{at.strftime('%Y%m%dT%H%M%S')}{at.microsecond:06d}Z-{kind}-{secrets.token_hex(6)}"


def _time_order(record_id: str) -> Tuple[str, int, str]:
    """Sort key for a valid record ID: its UTC second, then its microseconds. An ID from an earlier build has whole
    seconds only and sorts as the oldest of its second."""
    sub = record_id[15:21]
    return (record_id[:15], int(sub) if sub.isdigit() else -1, record_id)


def _need(cond: bool, path: str, message: str) -> None:
    if not cond:
        raise ReportError(f"{path} {message}")


def _is_str(v: object) -> bool:
    return isinstance(v, str)


def _is_num(v: object) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _check_workbook_info(v: Json, path: str) -> None:
    _need(isinstance(v, dict), path, "must be an object")
    for k in ("ref", "title", "hash", "python"):
        _need(_is_str(v.get(k)), f"{path}.{k}", "must be a string")


def _check_list(v: Json, path: str) -> List[Json]:
    _need(isinstance(v, list), path, "must be an array")
    return v


def _check_violation(v: Json, path: str) -> None:
    if v is None:
        return
    _need(isinstance(v, dict), path, "must be an object or null")
    _need(v.get("tier") in (1, 2), f"{path}.tier", "must be 1 or 2")
    for k in ("id", "rule", "detail"):
        _need(_is_str(v.get(k)), f"{path}.{k}", "must be a string")
    _need(v.get("cell") is None or _is_str(v.get("cell")), f"{path}.cell", "must be a string or null")


def _check_audit(r: Dict[str, Json]) -> None:
    _check_workbook_info(r.get("workbook"), "$.workbook")
    _need(r.get("verdict") in ("passed", "violated", "configError", "stopped"), "$.verdict", "is not a Suture verdict")
    _need(_is_num(r.get("seed")), "$.seed", "must be a number")
    for i, t in enumerate(_check_list(r.get("tier1"), "$.tier1")):
        _need(isinstance(t, dict) and _is_str(t.get("id")) and _is_str(t.get("status")), f"$.tier1[{i}]", "must be { id, status }")
    for i, t in enumerate(_check_list(r.get("tier2"), "$.tier2")):
        _need(isinstance(t, dict) and _is_str(t.get("id")) and _is_str(t.get("status")), f"$.tier2[{i}]", "must be { id, status }")
    _check_violation(r.get("violation"), "$.violation")
    for i, f in enumerate(_check_list(r.get("failingInputs"), "$.failingInputs")):
        _need(isinstance(f, dict) and _is_str(f.get("cell")) and "value" in f, f"$.failingInputs[{i}]", "must be { cell, value }")
    for i, step in enumerate(_check_list(r.get("lineage"), "$.lineage")):
        _need(isinstance(step, dict) and _is_str(step.get("cell")), f"$.lineage[{i}]", "must be { cell, dialect, value, base }")
        _need(step.get("dialect") in ("literal", "formula", "sql", "py", None), f"$.lineage[{i}].dialect", "is not a Suture dialect")
    replay = r.get("replay")
    if replay is not None:
        _need(isinstance(replay, dict), "$.replay", "must be an object or null")
        _need(isinstance(replay.get("artifact"), dict), "$.replay.artifact", "must be an object")
        _need(replay["artifact"].get("format") == "suture.replay", "$.replay.artifact.format", "must be 'suture.replay'")
        frag = replay.get("fragment")
        _need(frag is None or _is_str(frag), "$.replay.fragment", "must be a string or null")


def _check_patch(r: Dict[str, Json]) -> None:
    _check_workbook_info(r.get("workbook"), "$.workbook")
    _need(isinstance(r.get("ok"), bool), "$.ok", "must be a boolean")
    _need(_is_num(r.get("seed")), "$.seed", "must be a number")
    _need(r.get("counterexampleFixed") in (True, False, None), "$.counterexampleFixed", "must be a boolean or null")
    _need(isinstance(r.get("freshAuditPassed"), bool), "$.freshAuditPassed", "must be a boolean")
    for i, p in enumerate(_check_list(r.get("patches"), "$.patches")):
        _need(isinstance(p, dict) and _is_str(p.get("cell")) and _is_str(p.get("after")), f"$.patches[{i}]", "must be { cell, before, after }")
        _need(p.get("before") is None or _is_str(p.get("before")), f"$.patches[{i}].before", "must be a string or null")
    for i, g in enumerate(_check_list(r.get("regressions"), "$.regressions")):
        _need(isinstance(g, dict) and g.get("kind") in ("assertion", "newError") and _is_str(g.get("cell")), f"$.regressions[{i}]", "must be a Suture regression")
    for i, d in enumerate(_check_list(r.get("baseValueDiffs"), "$.baseValueDiffs")):
        _need(isinstance(d, dict) and _is_str(d.get("cell")) and "before" in d and "after" in d, f"$.baseValueDiffs[{i}]", "must be { cell, before, after }")
    for i, e in enumerate(_check_list(r.get("patchErrors"), "$.patchErrors")):
        _need(_is_str(e), f"$.patchErrors[{i}]", "must be a string")


def _check_workbooks(r: Dict[str, Json]) -> None:
    _need(_is_str(r.get("root")), "$.root", "must be a string")
    for i, f in enumerate(_check_list(r.get("flagships"), "$.flagships")):
        _need(isinstance(f, dict) and _is_str(f.get("id")) and _is_str(f.get("title")), f"$.flagships[{i}]", "must be { id, title, ... }")
    for i, f in enumerate(_check_list(r.get("files"), "$.files")):
        _need(isinstance(f, dict) and _is_str(f.get("path")), f"$.files[{i}]", "must be { path, ... }")
        _need(_is_str(f.get("error")) or (_is_str(f.get("title")) and _is_str(f.get("hash"))), f"$.files[{i}]", "needs a title and hash, or an error")


_CHECKS: Dict[str, Callable[[Dict[str, Json]], None]] = {"workbooks": _check_workbooks, "audit": _check_audit, "patch": _check_patch}


def validate_report(report: Json) -> str:
    """Validate a Suture tool result and return its record kind (``workbooks``, ``audit`` or ``patch``)."""
    _need(isinstance(report, dict), "$", "must be a JSON object")
    kind = KINDS.get(report.get("format"))
    _need(kind is not None, "$.format", "must be 'suture.workbooks', 'suture.audit' or 'suture.verify-patch'")
    _need(report.get("version") == 1, "$.version", "must be 1")
    assert kind is not None
    _CHECKS[kind](report)
    return kind


def replay_url(report: Dict[str, Json]) -> Optional[str]:
    """The X-Ray deep link for an audit report, or None when the fragment is absent or would not fit in a URL."""
    replay = report.get("replay")
    if not isinstance(replay, dict):
        return None
    frag = replay.get("fragment")
    if not isinstance(frag, str) or len(frag) + 1 > MAX_FRAGMENT_CHARS or not FRAGMENT_RE.fullmatch(frag):
        return None
    return REPLAY_BASE_URL + frag


def build_record(report: Json, source: str, agent: Optional[str], note: Optional[str], now: datetime) -> Dict[str, Json]:
    kind = validate_report(report)
    _need(source in SOURCES, "source", "must be 'workspace' or 'sample'")
    _need(agent is None or agent in AGENTS, "agent", "must name one of the three Suture Crew agents")
    _need(note is None or (isinstance(note, str) and len(note) <= MAX_NOTE_CHARS), "note", f"must be a string of at most {MAX_NOTE_CHARS} characters")
    size = len(json.dumps(report, separators=(",", ":"), ensure_ascii=False).encode("utf-8"))
    _need(size <= MAX_REPORT_BYTES, "report", f"is {size} bytes; the limit is {MAX_REPORT_BYTES}")
    return {
        "format": "suture-crew.record",
        "version": 1,
        "id": new_record_id(kind, now),
        "kind": kind,
        "recordedAt": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": source,
        "agent": agent,
        "note": note,
        "replayUrl": replay_url(report) if kind == "audit" else None,
        "report": report,
    }


def _atomic_write_json(path: Path, value: Json) -> None:
    """Write to a temporary file in the same directory, fsync it, then rename over the target."""
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}")
    data = json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
        raise


def _record_files(data_dir: Path) -> List[Path]:
    root = reports_dir(data_dir)
    if not root.is_dir():
        return []
    out = [p for p in root.iterdir() if p.suffix == ".json" and is_record_id(p.stem) and p.is_file() and not p.is_symlink()]
    # IDs start with a UTC timestamp; newest first.
    return sorted(out, key=lambda p: _time_order(p.stem), reverse=True)


def save_record(data_dir: Path, record: Dict[str, Json]) -> Path:
    root = reports_dir(data_dir)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = record_path(data_dir, record["id"])
    _atomic_write_json(path, record)
    for stale in _record_files(data_dir)[MAX_RECORDS:]:
        stale.unlink(missing_ok=True)
    return path


def load_record(data_dir: Path, record_id: str) -> Optional[Dict[str, Json]]:
    """The stored record, or None when it does not exist or is not a valid record."""
    path = record_path(data_dir, record_id)
    if not path.is_file() or path.is_symlink():
        return None
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or value.get("format") != "suture-crew.record" or value.get("id") != record_id:
        return None
    try:
        validate_report(value.get("report"))
    except ReportError:
        return None
    return value


def summarize(record: Dict[str, Json]) -> Dict[str, Json]:
    report = record["report"]
    kind = record["kind"]
    workbook: Optional[Dict[str, Json]] = None
    status: str
    detail: Optional[str] = None
    if kind == "workbooks":
        files = report.get("files", [])
        status = f"{len(files)} file(s)"
    else:
        wb = report["workbook"]
        workbook = {"ref": wb["ref"], "title": wb["title"], "hash": wb["hash"]}
        if kind == "audit":
            status = report["verdict"]
            violation = report.get("violation")
            detail = violation["id"] if isinstance(violation, dict) else None
        else:
            status = "verified" if report["ok"] else "rejected"
            detail = f"{len(report.get('regressions', []))} regression(s)"
    return {
        "id": record["id"],
        "kind": kind,
        "recordedAt": record["recordedAt"],
        "source": record["source"],
        "agent": record.get("agent"),
        "workbook": workbook,
        "status": status,
        "detail": detail,
        "replayUrl": record.get("replayUrl"),
    }


def list_summaries(data_dir: Path) -> List[Dict[str, Json]]:
    out: List[Dict[str, Json]] = []
    for path in _record_files(data_dir):
        record = load_record(data_dir, path.stem)
        if record is not None:
            out.append(summarize(record))
    return out


# ---------------------------------------------------------------------------
# MCP server (stdio, newline-delimited JSON-RPC 2.0)
# ---------------------------------------------------------------------------

TOOL: Dict[str, Json] = {
    "name": TOOL_NAME,
    "title": "Record a Suture report in the Suture Crew ledger",
    "description": (
        "Stores one Suture report so the Suture Crew dashboard can show it. Pass the unmodified JSON object returned by "
        "suture_list_workbooks, suture_run_audit, or suture_verify_patch as `report`, and `source` = 'workspace' for "
        "the @suture-crew:suture server or 'sample' for the @suture-sample server. Returns the record id and, for a "
        "violated audit, the Suture X-Ray replay link. Writes only to the app's own data directory."
    ),
    "inputSchema": {
        "type": "object",
        "properties": {
            "report": {"type": "object", "description": "The Suture tool's JSON result, unmodified."},
            "source": {"type": "string", "enum": list(SOURCES), "description": "Which Suture server produced the report."},
            "agent": {"type": "string", "enum": list(AGENTS), "description": "The Suture Crew agent recording it."},
            "note": {"type": "string", "maxLength": MAX_NOTE_CHARS, "description": "Optional one-line context for the human reviewer."},
        },
        "required": ["report", "source"],
        "additionalProperties": False,
    },
    "annotations": {"readOnlyHint": False, "destructiveHint": False, "idempotentHint": False, "openWorldHint": False},
}


class RpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def _tool_text(payload: Dict[str, Json], is_error: bool = False) -> Dict[str, Json]:
    if is_error:
        return {"content": [{"type": "text", "text": payload["error"]}], "isError": True}
    return {"content": [{"type": "text", "text": json.dumps(payload, indent=2)}], "structuredContent": payload}


def call_record_tool(arguments: Json, data_dir: Path, now: Optional[datetime] = None) -> Dict[str, Json]:
    if not isinstance(arguments, dict):
        return _tool_text({"error": "arguments must be an object"}, is_error=True)
    unknown = sorted(set(arguments) - {"report", "source", "agent", "note"})
    if unknown:
        return _tool_text({"error": f"unknown argument(s): {', '.join(unknown)}"}, is_error=True)
    report = arguments.get("report")
    if isinstance(report, str):
        try:
            report = json.loads(report)
        except json.JSONDecodeError as exc:
            return _tool_text({"error": f"report is not valid JSON: {exc.msg}"}, is_error=True)
    try:
        record = build_record(report, arguments.get("source", ""), arguments.get("agent"), arguments.get("note"), now or datetime.now(timezone.utc))
        save_record(data_dir, record)
    except ReportError as exc:
        return _tool_text({"error": f"not recorded: {exc}"}, is_error=True)
    except OSError as exc:
        return _tool_text({"error": f"not recorded: could not write the ledger ({exc.strerror or exc})"}, is_error=True)
    summary = summarize(record)
    return _tool_text({"recorded": True, **summary})


class LedgerServer:
    def __init__(self, data_dir: Path) -> None:
        self.data_dir = data_dir

    def _server_info(self) -> Dict[str, str]:
        return {"name": SERVER_NAME, "version": SERVER_VERSION}

    def _capabilities(self) -> Dict[str, Json]:
        return {"tools": {"listChanged": False}}

    def _dispatch(self, method: str, params: Dict[str, Json]) -> Dict[str, Json]:
        if method == "initialize":
            requested = params.get("protocolVersion")
            version = requested if requested in SESSION_PROTOCOLS else LATEST_PROTOCOL
            return {"protocolVersion": version, "capabilities": self._capabilities(), "serverInfo": self._server_info(), "instructions": INSTRUCTIONS}
        if method == "server/discover":
            return {"supportedVersions": [STATELESS_PROTOCOL, *SESSION_PROTOCOLS], "capabilities": self._capabilities(), "instructions": INSTRUCTIONS}
        if method == "ping":
            return {}
        if method == "tools/list":
            return {"tools": [TOOL]}
        if method == "tools/call":
            name = params.get("name")
            if name != TOOL_NAME:
                raise RpcError(-32602, f"unknown tool: {name}")
            return call_record_tool(params.get("arguments", {}), self.data_dir)
        raise RpcError(-32601, "Method not found")

    def handle(self, message: Json) -> Optional[Dict[str, Json]]:
        """Answer one parsed JSON-RPC message; None for a notification (no reply is sent)."""
        if not isinstance(message, dict) or message.get("jsonrpc") != "2.0" or not isinstance(message.get("method"), str):
            if isinstance(message, dict) and "method" not in message and ("result" in message or "error" in message):
                return None  # a response to a request this server never sends
            return {"jsonrpc": "2.0", "id": message.get("id") if isinstance(message, dict) else None, "error": {"code": -32600, "message": "Invalid Request"}}
        if "id" not in message:
            return None
        msg_id = message["id"]
        params = message.get("params") or {}
        if not isinstance(params, dict):
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32602, "message": "params must be an object"}}
        try:
            result = self._dispatch(message["method"], params)
        except RpcError as exc:
            return {"jsonrpc": "2.0", "id": msg_id, "error": {"code": exc.code, "message": exc.message}}
        meta = params.get("_meta")
        if isinstance(meta, dict) and meta.get(PROTOCOL_META_KEY) == STATELESS_PROTOCOL:
            # The 2026-07-28 revision answers each request without a session; mirror the reference SDK's result envelope.
            result = {**result, "resultType": "complete", "ttlMs": 0, "cacheScope": "private", "_meta": {SERVER_INFO_META_KEY: self._server_info()}}
        return {"jsonrpc": "2.0", "id": msg_id, "result": result}

    def handle_line(self, line: str) -> Optional[Dict[str, Json]]:
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": "Parse error"}}
        if isinstance(message, list):
            return {"jsonrpc": "2.0", "id": None, "error": {"code": -32600, "message": "JSON-RPC batches are not supported"}}
        return self.handle(message)


def serve(stdin: Iterable[str], stdout: TextIO, data_dir: Path) -> None:
    server = LedgerServer(data_dir)
    for raw in stdin:
        line = raw.strip()
        if not line:
            continue
        reply = server.handle_line(line)
        if reply is not None:
            stdout.write(json.dumps(reply, ensure_ascii=False, separators=(",", ":")) + "\n")
            stdout.flush()


def main() -> int:
    # stdout carries only JSON-RPC; diagnostics go to stderr.
    for stream in (sys.stdin, sys.stdout):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is not None:
            reconfigure(encoding="utf-8")
    data_dir = resolve_data_dir()
    print(f"{SERVER_NAME} {SERVER_VERSION}: serving on stdio, ledger {reports_dir(data_dir)}", file=sys.stderr)
    serve(sys.stdin, sys.stdout, data_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
