# Spec 01 — Suture Crew App: tasks

Each task names the requirements it covers and the evidence that verified it. Evidence was gathered on 2026-11-21
against KiroCrew `44b184c` (Kiro Crew 0.14.0) and SUTURE `5eccda0`; CI re-runs every check on each push.

- [x] **1. Verify the Kiro Crew App contract before writing files** (Req 1, 2, 6)
  - Read the manifest validator, UI server, AppHost loader, import map, agent and MCP registrars, hook loader, cron
    registrar and cron API in the KiroCrew source; recorded in `design.md` §1.
  - Found that third-party `agentTools` are not listed, so the ledger became an app-owned MCP server (approved).
  - Evidence: `design.md` §1 table, with file references.

- [x] **2. Bundled sample with a real bug** (Req 2.3)
  - `samples/wholesale-quote.suture.json`: additive discount stacking in DuckDB SQL; no `=PY()`.
  - Evidence: `suture audit` (SUTURE CLI) → `✗ net-price-positive`, shrunk inputs `B3=0.4, B4=0.4, B5=0.2`,
    broken edge `Pricing!A1 → Quote!B2`. `prove-sample.mjs`: `suture_verify_patch` with the compounded-discount SQL →
    `ok: true`, `counterexampleFixed: true`, `freshAuditPassed: true`, `regressions: 0`.

- [x] **3. Ledger MCP server and store** (Req 5.1–5.5, 5.8)
  - `backend/ledger_mcp.py`, stdlib only; record ids generated server-side; temp + fsync + `os.replace` writes.
  - Evidence: `tooling/pytests/test_ledger_mcp.py` (real process over stdio: session and stateless handshakes,
    -32700/-32600/-32601/-32602, invalid reports write nothing, failed rename leaves no temp file, pruning, 0600 files).

- [x] **4. Read routes** (Req 5.6, 5.7)
  - `backend/routes.py` (`GET /status`, `/reports`, `/reports/{record_id}`), file access off the event loop.
  - Evidence: `tooling/pytests/test_routes.py` (reads what the store wrote via `ctx.data_dir`; env override; invalid ids
    → 400; missing → 404). `crew_check.py`: the gateway's `load_app_module` imports the hook from the installed copy,
    `_route_fields` accepts all three routes, `GET /status` answers 200.

- [x] **5. Agents and skills** (Req 3)
  - `agents/{schema-archaeologist,invariant-adversary,formula-surgeon}.json`,
    `skills/{suture-audit-playbook,suture-replay-triage}/SKILL.md`.
  - Evidence: `tooling/test/agents-skills.test.ts` (tool references resolve against the four Suture tools and the
    ledger's live `tools/list`; auto-approval excludes workspace audits and `fs_write`; frontmatter). `crew_check.py`:
    all three agents registered with `suture-crew:suture`, `suture-crew:ledger` and `suture-sample` merged,
    `{APP_ROOT}/samples` rendered to the install path, `tools`/`allowedTools` unchanged; both skills registered.
  - Finding: Crew strips built-in tools from app agents' `allowedTools`, so only MCP references are listed there.

- [x] **6. Manifest, permissions, schedule, icon** (Req 1, 2.1, 4.1, 4.2, 7.1)
  - `app.json`; `assets/icon.png` from `tooling/scripts/gen-icon.mjs`.
  - Evidence: `tooling/test/manifest.test.ts`, `tooling/test/icon.test.ts` (512×512, colour type 2, no `tRNS`, valid
    CRCs, pixels equal the generator's). `crew_check.py`: `AppManifest.validate` → no errors; `install_app` →
    `installed suture-crew v1.0.0`; `register_app` → cron `suture-crew/nightly-model-audit` defined with
    `enabled: false`, agent `invariant-adversary`.

- [x] **7. Dashboard page** (Req 6)
  - `ui/src/*`, built to `ui/dist/index.mjs` by `tooling/vite.config.ts`.
  - Evidence: `tooling/test/bundle.test.ts` (imports exactly `@kirocrew/app-sdk`, `react`, `react/jsx-runtime`; no
    React internals; default export; tokens present). `tooling/test/ui.test.tsx` (triage pane with chain
    `IN → SQL → FX`, shrunk inputs and the X-Ray href built from the real fragment; patch pane with the four checks,
    diff and `baseValueDiffs`; queue; dispatch; cron; import fallback). `manifest.test.ts`: every `/api/` path in the
    bundle is under `permissions.api`.

- [x] **8. Licensing and trademark hygiene** (Req 7.2–7.5)
  - `tooling/scripts/license-audit.mjs`, `tooling/scripts/py_license_audit.py`, `tooling/scripts/trademark-scan.mjs`.
  - Evidence: npm audit 48 packages (MIT 42, Apache-2.0 3, ISC 2, BSD-3-Clause 1); pip audit 15 distributions; both
    0 copyleft, 0 unlicensed. Trademark scan: 0 hits. `tooling/test/hygiene.test.ts`: MIT `LICENSE`, `.kiro/` not
    ignored (`git check-ignore`), hooks follow the v1 schema, no `any`, no placeholder markers.

- [x] **9. Kiro workflow files** (Req 7.4)
  - `.kiro/steering/suture-crew-architecture.md`, this spec, `.kiro/hooks/crew-app-guard.json` (PostFileSave: rebuild
    the bundle and run the manifest/bundle/hygiene checks; Stop: license audit and trademark scan).

- [x] **10. CI and docs** (Req 8)
  - `.github/workflows/ci.yml`: `verify` (bundle drift, Vitest, pytest, audits), `crew-integration` (pinned KiroCrew
    installer and registrar), `suture-e2e` (pinned SUTURE build + `prove-sample.mjs`).
  - `README.md`: install command, npm status, publish steps, zero-npm fallback (`use-local-suture.mjs`, tested by
    `tooling/test/use-local-suture.test.ts`), workspace and cron setup, architecture.
  - Evidence: GitHub Actions run on the PR branch (linked in PR #1).

## Open items

- `@suture/mcp@0.1.0` must be published from `g4stein/SUTURE` before the default `npx` launcher works on a machine
  without the local fallback (README, "The Suture engine").
- The dashboard page has been rendered under test but not yet clicked through in a running Kiro Crew dashboard.
