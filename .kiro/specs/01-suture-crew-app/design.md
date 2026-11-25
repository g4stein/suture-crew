# Spec 01 — Suture Crew App: design

## 1. Verified platform contract

Checked against `kirodotdev/KiroCrew` source (commits `dd9bf6d` and `44b184c`, Kiro Crew 0.14.0) and the docs at
kiro.dev/docs/crew/apps. Where the website and the source disagreed, the source won.

| Topic | Contract | Source |
|---|---|---|
| UI bundle path | `ui.entry` is checked against the app root but served from `ui/`: `/apps/{name}/ui/{entry}`. `"entry": "dist/index.mjs"` → `ui/dist/index.mjs` | `apps/manifest.py`, `apps/app_frame.py`, `website/src/components/AppHost.tsx` |
| Page module | Loaded with `React.lazy(import(path))`: the default export is the page. `mountFunction` is parsed but unused by the dashboard | `AppHost.tsx`, `appBundleImport.ts` |
| Host modules | Import map: `react`, `react-dom`, `react-dom/client`, `react/jsx-runtime`, `@kirocrew/app-sdk`, `@kirocrew/app-sdk/ui`, `@tanstack/react-query`, `lucide-react` | `website/scripts/lib/basePath.mjs` |
| Host React | 18.3 | `website/package.json` |
| Agents | kiro-cli agent JSON, copied to `<kiro home>/agents/<app>--<name>.json`, dispatched by the plain `name` | `apps/bridges_agents.py` |
| App MCP servers | Registered as `<app>:<server>` and merged into each app agent; referenced as `@suture-crew:suture/<tool>` (Crew parses the server as the text before the first `/`) | `bridges_agents.py` `_own_mcp_servers`, line 639 |
| Placeholders | `{APP_ROOT}`, `{APP_DATA}`, `{UV_BIN}`, `{HOST_PATH}`, `{PATH_SEP}` rendered in agent files only | `apps/agent_template_values.py` |
| `python3` launcher | A bare `python3` with an app-relative `.py` argument is resolved under the app root (Crew adds `-s`) | manifest reference; crew-check output |
| allowedTools | Crew strips built-in tools from an app agent's `allowedTools`; MCP tool references survive | crew-check output |
| Hooks | `backend.hooks.routes` → `register_routes(ctx)` returns objects with `method`, `path`, `handler(request, ctx)`; served at `/api/apps/<app>/<path>`; `ctx.data_dir` = `app_dir(name) / "data"` | `apps/route_registry.py`, `apps/hooks_integration.py`, `apps/manager_records.py` |
| agentTools | Listed only for first-party apps; a third-party app must ship its own MCP server | manifest reference, `agentTools` |
| Crons | `enabled: false` registers paused; the job is named `<app>/<cron>`; `permissions.cron: true` is required when `crons` is non-empty | `apps/bridges_crons.py`, manifest reference |
| Cron API | `GET /api/crons` → `{ jobs: [...] }`; `POST /api/crons/{id}/enable { enabled }`; `POST /api/crons/{id}/run` | `dashboard/handlers/cron_board.py`, `cron_jobs.py` |
| Installs | CLI git install runs no build. A registry install runs `npm install` (+ `npm run build`) for a root `package.json`, or `pip install` for a root Python manifest; failure fails the install | `apps/git_install.py`, `apps/registry.py` |
| Icon | `iconPath`; the scaffold writes an opaque truecolor PNG at 512×512 | `apps/scaffold.py` |
| MCP env | kiro-cli expands `${VAR}` in `env`, never in `args`; MCP children inherit the gateway environment | `env.py` |

The Suture side (`g4stein/SUTURE` `5eccda0`): `packages/mcp` registers the four tools; the server root is `--root`,
then `SUTURE_WORKSPACE`, then the current directory; `AuditReport`, `VerifyPatchReport` and `suture.workbooks` shapes
come from `packages/runtime/src/headless`. The engine is published on npm as `@g4stein/suture-mcp@0.1.0` (MIT); it was unpublished while spec 01 was built, so CI first proved it against a local build.

## 2. Architecture

```
                       Kiro Crew gateway
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ Dashboard page  ui/dist/index.mjs (React from host import map)           │
 │   useAppApi ──► /api/apps/suture-crew/{status,reports,reports/{id}}      │
 │             └─► /api/crons, /api/crons/{id}/enable, /api/crons/{id}/run  │
 │   useChatLauncher.openChat({ agent, message })                           │
 │                                                                          │
 │ backend/routes.py (backend.hooks.routes, in-process, read-only)          │
 │   └─ reads <app>/data/reports/*.json  ◄──────────────┐                   │
 │                                                      │ atomic writes     │
 │ Cron nightly-model-audit (paused) ─► invariant-adversary                 │
 └──────────────────────────────────────────────────────┼───────────────────┘
          kiro-cli sessions: 3 agents + 2 skills        │
   @suture-crew:suture ── npx @g4stein/suture-mcp@0.1.0  (root: SUTURE_WORKSPACE | cwd)
   @suture-sample ────── npx @g4stein/suture-mcp@0.1.0 --root {APP_ROOT}/samples
   @suture-crew:ledger ─ python3 backend/ledger_mcp.py ──┘  suture_crew_record_audit
                                                      │
                     Open in Suture X-Ray ──► https://suture-nu.vercel.app/#replay=v1.…
```

## 3. Components

### 3.1 Ledger (`backend/ledger_mcp.py`)

- One module holds the store and the MCP loop; `routes.py` imports the store with a relative import, so writer and
  reader share `resolve_data_dir`, `RECORD_ID_RE` and the validators.
- Data dir: `SUTURE_CREW_DATA_DIR` if set, else `Path(__file__).absolute().parent.parent / "data"`, which equals the
  hook's `ctx.data_dir` (`app_dir(name) / "data"`) because Crew installs the tree at `app_dir(name)`.
- Record id: `YYYYMMDDTHHMMSSffffffZ-<kind>-<12 hex>` (UTC to the microsecond, kept strictly increasing within the
  process), generated by the server. Clients never supply a path. Listings sort by the stamp, newest first, so records
  from the same second keep their order; ids from earlier builds (`YYYYMMDDTHHMMSSZ-…`) still load and sort as the
  oldest of their second.
- Record: `{ format: "suture-crew.record", version: 1, id, kind, recordedAt, source, agent, note, replayUrl, report }`.
  `replayUrl` is computed from `report.replay.fragment` only when it matches `^replay=v1\.[A-Za-z0-9_-]+$` and fits in
  8,192 characters.
- Writes: `os.open(O_EXCL, 0600)` temp file in the same folder, fsync, `os.replace`; the temp file is removed on any
  failure. Listings ignore names that are not `<id>.json`, so temporary files are never read.
- Protocol: newline-delimited JSON-RPC 2.0. `initialize` echoes a supported session revision (2025-11-25, 2025-06-18,
  2025-03-26, 2024-11-05) or answers 2025-11-25. `server/discover` lists 2026-07-28 first. A request whose `_meta`
  names 2026-07-28 gets the stateless envelope (`resultType`, `ttlMs`, `cacheScope`, `_meta.serverInfo`) the reference
  SDK emits, observed from Suture's own server. Batches are refused (-32600).

### 3.2 Routes (`backend/routes.py`)

`GET /status`, `GET /reports` (summaries, newest first), `GET /reports/{record_id}` (400 for an invalid id, 404 when
missing). File access runs in `asyncio.to_thread`. No route writes, so none needs the owner gate.

### 3.3 Agents and skills

| Agent | Tools | Auto-approved |
|---|---|---|
| schema-archaeologist | fs_read, grep, glob, list/inspect on both Suture servers, ledger | list/inspect on both servers, ledger |
| invariant-adversary | fs_read, list/inspect/run_audit on both servers, ledger | list/inspect on both, sample run_audit, ledger |
| formula-surgeon | fs_read, fs_write, grep, glob, inspect/run_audit/verify_patch on both, ledger | inspect on both, sample run_audit/verify_patch, ledger |

The sample server is safe to auto-approve: its root holds only the bundled workbook (no `=PY()`), and the built-in
flagships are Suture's own code. Workspace audits ask because `trustPython` can execute workbook Python under Node.

### 3.4 Sample workbook

`samples/wholesale-quote.suture.json`: `Pricing!A1` adds three discounts in DuckDB SQL
(`price * (1 - (a + b + c))`); `Quote!B2 = Pricing!A1`, `Quote!B4 = (B2-B3)/B2`. Assertions: `net-price-positive`
(`Quote!B2 > 0`), `margin-at-most-100pct` (`Quote!B4 ≤ 1`), `margin-defined`. The Exorcist shrinks to discounts
summing to exactly 1.0 (price 0, a division cliff at `Quote!B4`). The non-masking fix compounds the discounts:
`price * (1 - a) * (1 - b) * (1 - c)`.

### 3.5 Dashboard page

- `ui/src/model.ts`: shapes, guards (`unknown` until accepted) and pure derivations (`buildQueue`, `lineageChain`,
  `replayUrl`, `patchChecks`, `findCron`, `dispatchMessage`).
- `ui/src/components.tsx`: props-only components (queue, cron card, triage pane, patch pane, dispatch bar, import panel).
- `ui/src/index.tsx`: the only SDK consumer; polls the ledger every 15 s.
- `ui/src/kirocrew-app-sdk.d.ts`: types for the four SDK names used, copied from the KiroCrew source.
- Built by `tooling/vite.config.ts` (library mode, ESM, esbuild JSX, `HOST_EXTERNALS` external, not minified).

### 3.6 Permissions

| Permission | Why |
|---|---|
| `api: /api/crons` | Read the app's cron, pause/resume it, run it now |
| `api: /api/apps/suture-crew` | Read the ledger routes |
| `cron: true` | Required by Crew because `crons` is non-empty |
| `storage: false` | The ledger uses `ctx.data_dir`, not `ctx.storage` |
| `network: false` | The app's code makes no network requests. `npx` downloads `@g4stein/suture-mcp` once, and Pyodide may fetch NumPy for trusted `=PY()` workbooks; both are the engine's, launched by kiro-cli |

## 4. Repository layout

```
app.json  LICENSE  README.md  .gitignore
assets/icon.png
agents/{schema-archaeologist,invariant-adversary,formula-surgeon}.json
skills/{suture-audit-playbook,suture-replay-triage}/SKILL.md
samples/wholesale-quote.suture.json
backend/{ledger_mcp.py,routes.py}
ui/src/{index.tsx,components.tsx,model.ts,theme.ts,kirocrew-app-sdk.d.ts}  ui/dist/index.mjs
tooling/  package.json pnpm-lock.yaml vite/vitest/ts configs, test/, pytests/, scripts/, crew-check/, fixtures/
.kiro/    steering/, specs/01-suture-crew-app/, hooks/
.github/workflows/ci.yml
```

## 5. Verification design

| Check | Tool |
|---|---|
| Manifest rules, containment, files exist | `tooling/test/manifest.test.ts` |
| Gateway's own validator, installer, registrar, hook loader | `tooling/crew-check/crew_check.py` (CI, pinned KiroCrew) |
| Icon validity, opacity, size, palette, determinism | `tooling/test/icon.test.ts` |
| Agents/skills parse; tool refs resolve; ledger tool list from the live process | `tooling/test/agents-skills.test.ts` |
| Bundle imports only host modules; default export | `tooling/test/bundle.test.ts`; CI `git diff --exit-code ui/dist` |
| Model + components against real Suture reports | `tooling/test/ui.test.tsx` |
| Ledger protocol, store, validation, atomicity, routes | `tooling/pytests/` |
| Licenses (npm, pip) | `scripts/license-audit.mjs`, `scripts/py_license_audit.py` |
| Trademarks | `scripts/trademark-scan.mjs` |
| End to end with the real engine | `scripts/prove-sample.mjs` (CI, pinned SUTURE) |
