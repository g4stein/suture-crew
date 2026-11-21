#!/usr/bin/env python3
"""Install Suture Crew into a throwaway Kiro Crew home with the real gateway code and check what it registers.

Needs a KiroCrew checkout installed in the running interpreter (``pip install -e <KiroCrew>``; Python 3.12+). Set
``KIROCREW_HOME`` and ``HOME`` to empty temporary directories first; ``tooling/crew-check/run.sh`` does both. Steps:

1. ``AppManifest.validate`` on app.json (the install-time validator) returns no errors.
2. ``install_app`` copies the app into ``$KIROCREW_HOME/apps/suture-crew`` (node_modules and .git dropped).
3. ``register_app`` registers the agents, skills, MCP servers and crons, and the checks below read what it wrote:
   the three agents, with ``{APP_ROOT}`` rendered and both app servers merged in; the namespaced MCP servers, with the
   ledger's ``backend/ledger_mcp.py`` resolved to an absolute path inside the install; and the two skills.
4. The gateway's own hook loader imports ``backend.routes:register_routes`` from the installed copy, and each route
   answers through the gateway's route-shape check.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
from typing import Dict, List

REPO = Path(__file__).resolve().parents[2]
APP = "suture-crew"


def fail(msg: str) -> None:
    print(f"FAIL: {msg}", file=sys.stderr)
    sys.exit(1)


def ok(msg: str) -> None:
    print(f"  ✓ {msg}")


def main() -> int:
    for var in ("KIROCREW_HOME", "HOME"):
        if not os.environ.get(var):
            fail(f"{var} must point at an empty temporary directory")

    from kiro_crew.apps.manifest import AppManifest
    from kiro_crew.apps.manager import app_dir
    from kiro_crew.apps.manager_install import install_app
    from kiro_crew.apps.bridges_register import register_app
    from kiro_crew.apps.bridges_sources import _kiro_agents_dir
    from kiro_crew.apps.module_loader import load_app_module
    from kiro_crew.apps.route_registry import _route_fields

    raw = json.loads((REPO / "app.json").read_text(encoding="utf-8"))
    errors = AppManifest.from_dict(raw).validate(REPO)
    if errors:
        fail(f"AppManifest.validate: {errors}")
    ok("AppManifest.validate(app.json) reports no errors")

    result = install_app(str(REPO))
    if not result.ok:
        fail(f"install_app: {result.error}")
    installed = app_dir(APP)
    for dropped in ("tooling/node_modules", ".git"):
        if (installed / dropped).exists():
            fail(f"{dropped} was copied into the install")
    if not (installed / "ui" / "dist" / "index.mjs").is_file():
        fail("ui/dist/index.mjs is missing from the install")
    ok(f"install_app: {result.message}; ui/dist/index.mjs present, node_modules and .git dropped")

    # The owner's trust grant, written through the same trust writer the dashboard's install prompt uses.
    from kiro_crew.apps.agent_config_writer import mutate_trust_settings

    def trust(agent_raw: Dict[str, object]) -> None:
        current = agent_raw.get("apps_trusted")
        names = [str(x) for x in current] if isinstance(current, list) else []
        agent_raw["apps_trusted"] = sorted(set(names) | {APP})

    asyncio.run(mutate_trust_settings(trust))
    ok("owner trust granted (agent.apps_trusted)")

    reg = register_app(APP)
    if reg.errors:
        fail(f"register_app errors: {reg.errors}")
    agents_dir = _kiro_agents_dir()
    names = ["schema-archaeologist", "invariant-adversary", "formula-surgeon"]
    for name in names:
        path = agents_dir / f"{APP}--{name}.json"
        if not path.is_file():
            # A templated agent is rendered under the data home; the agents dir points at the rendered copy.
            candidates = sorted(p.name for p in agents_dir.glob(f"{APP}--*"))
            fail(f"agent {name} was not registered (agents dir has {candidates})")
        spec = json.loads(path.read_text(encoding="utf-8"))
        servers: Dict[str, Dict[str, object]] = spec.get("mcpServers", {})
        for key in (f"{APP}:suture", f"{APP}:ledger", "suture-sample"):
            if key not in servers:
                fail(f"agent {name} lacks MCP server {key}: {sorted(servers)}")
        sample_args = servers["suture-sample"].get("args")
        if not isinstance(sample_args, list) or sample_args[-1] != f"{installed}/samples":
            fail(f"agent {name}: {{APP_ROOT}} not rendered to the install dir: {sample_args}")
        source = json.loads((REPO / "agents" / f"{name}.json").read_text(encoding="utf-8"))
        for key in ("tools", "allowedTools"):
            if spec.get(key) != source[key]:
                fail(f"agent {name}: {key} changed on registration: {spec.get(key)}")
        if "{APP_ROOT}" in json.dumps(spec):
            fail(f"agent {name} still contains a literal placeholder")
        ok(f"agent {name} registered; servers {sorted(servers)}; {{APP_ROOT}}/samples -> {sample_args[-1]}")

    ledger = None
    for path in sorted(agents_dir.glob(f"{APP}--*.json")):
        spec = json.loads(path.read_text(encoding="utf-8"))
        ledger = spec.get("mcpServers", {}).get(f"{APP}:ledger") or ledger
    if not isinstance(ledger, dict):
        fail("no ledger server in the registered agents")
    args: List[str] = list(ledger.get("args", []))
    expected = str(installed / "backend" / "ledger_mcp.py")
    # Crew may add interpreter flags (such as -s) before the script; the script operand is the last argument.
    if not args or args[-1] != expected:
        fail(f"ledger args not resolved under the install: {args} (expected the last one to be {expected})")
    ok(f"ledger MCP launcher: {ledger.get('command')} {' '.join(args)}")

    if sorted(reg.skills) != sorted([f"{APP}/suture-audit-playbook", f"{APP}/suture-replay-triage"]):
        fail(f"skills registered: {reg.skills}")
    ok(f"skills registered: {sorted(reg.skills)}")

    if reg.crons != [f"{APP}/nightly-model-audit"]:
        fail(f"crons registered: {reg.crons}")
    # app-crons.json is the scheduler definition Crew derives from the manifest (bridges_crons._cron_defs_from_manifest).
    jobs = json.loads((installed / "app-crons.json").read_text(encoding="utf-8"))
    if len(jobs) != 1 or jobs[0].get("enabled") is not False or jobs[0].get("agent") != "invariant-adversary":
        fail(f"nightly-model-audit is not defined paused for invariant-adversary: {jobs}")
    ok(f"cron {jobs[0]['name']} defined paused (enabled: false, cron_expr {jobs[0]['cron_expr']}, agent {jobs[0]['agent']})")

    register = load_app_module(APP, installed, "backend.routes:register_routes")

    class Ctx:
        data_dir = installed / "data"

    routes = register(Ctx())
    shapes = [_route_fields(r) for r in routes]
    if any(s is None for s in shapes):
        fail("a route was rejected by the gateway's route-shape check")
    ok(f"gateway hook loader imported backend.routes; routes {[(s[0], s[1]) for s in shapes if s is not None]}")

    from aiohttp.test_utils import make_mocked_request

    status_route = next(r for r in routes if r.path == "/status")
    resp = asyncio.run(status_route.handler(make_mocked_request("GET", f"/api/apps/{APP}/status"), Ctx()))
    body = json.loads(resp.text or "{}")
    if resp.status != 200 or body.get("records") != 0:
        fail(f"GET /status answered {resp.status} {body}")
    ok(f"GET /api/apps/{APP}/status -> {body}")
    print("Kiro Crew integration check complete.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
