# Suture Crew

[![CI](https://github.com/g4stein/suture-crew/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/g4stein/suture-crew/actions/workflows/ci.yml)

Always-on audits for spreadsheet models, as a [Kiro Crew](https://github.com/kirodotdev/KiroCrew) App.

[Suture](https://github.com/g4stein/SUTURE) ([live app](https://suture-nu.vercel.app)) catches silent bugs in
`.suture.json` models that mix formulas, DuckDB SQL and Python. Its Exorcist fuzzes a model's inputs and shrinks any
failure to a minimal counterexample. Suture Crew runs that same engine unattended:

- **Schema Archaeologist** maps sheets and the `SQL → PY → FX` lineage of every asserted cell, and flags untrusted
  Python and division cliffs.
- **Invariant Adversary** runs the Exorcist, classifies Tier 1 invariant and Tier 2 assertion failures, and turns each
  counterexample into a one-click **Suture X-Ray** link (`https://suture-nu.vercel.app/#replay=v1.…`).
- **Formula Surgeon** fixes the upstream cause (never `IFERROR` over the symptom) and recommends a diff only after
  `suture_verify_patch` returns `counterexampleFixed: true`, `freshAuditPassed: true` and `regressions: []`.
- **nightly-model-audit** runs every night once you resume it. It ships paused. With no workspace models it audits the
  bundled sample unattended; audits of your workspace `.suture.json` files ask for your approval first (see
  [Point it at your workspace](#point-it-at-your-workspace)).
- A **dashboard page** shows the monitored-workbook queue, the counterexample triage pane, the patch verification
  diff, cron controls, and one dispatch button per agent.

## Install

```bash
kirocrew app install https://github.com/g4stein/suture-crew.git --ref main
```

Installing from a git URL needs Kiro Crew 0.13.0 or later. The app installs disabled, as every app does, and Kiro Crew
refuses to enable a third-party app until you trust it. Then either:

- open the dashboard's App Store, find Suture Crew on the **Library** tab and press **Enable**. It asks you to trust
  this app and enables it; or
- turn on **Trust every third-party app** in **Settings → Security → Third-party apps**, then run
  `kirocrew app enable suture-crew`. The CLI shows no trust prompt, so it refuses an app that is not trusted yet.
  That switch trusts every third-party app on the gateway, not only this one.

Requirements on the gateway host: `node` and `npx` (Node 22+) and `python3`.

### The Suture engine: `@g4stein/suture-mcp@0.1.0`

The app launches Suture's MCP server with `npx -y @g4stein/suture-mcp@0.1.0` (`app.json` → `mcpServers.suture`, and
the `suture-sample` server in each agent file). The package is
[published on npm](https://www.npmjs.com/package/@g4stein/suture-mcp) (MIT) from
[`g4stein/SUTURE` `packages/mcp`](https://github.com/g4stein/SUTURE/tree/main/packages/mcp). `npx` downloads it on the
first run; nothing else needs installing. CI runs the end-to-end proof against the published package on every push.

**Optional offline fallback** (no npm fetch; two local clones):

```bash
git clone https://github.com/g4stein/SUTURE.git
(cd SUTURE && pnpm install && pnpm --filter "@g4stein/suture-mcp..." build)   # builds packages/mcp/dist/suture-mcp.mjs

git clone https://github.com/g4stein/suture-crew.git
node suture-crew/tooling/scripts/use-local-suture.mjs --local "$PWD/SUTURE"
# app.json and the agents now launch: node <SUTURE>/packages/mcp/dist/suture-mcp.mjs

kirocrew app install ./suture-crew
# then trust and enable it as in Install above
```

The same script switches back, or to another exact version:
`node tooling/scripts/use-local-suture.mjs --npm @g4stein/suture-mcp@0.1.0`.

To check the engine end to end without Kiro Crew:

```bash
node suture-crew/tooling/scripts/prove-sample.mjs                     # uses npx -y @g4stein/suture-mcp@0.1.0
SUTURE_MCP_ENTRY="$PWD/SUTURE/packages/mcp/dist/suture-mcp.mjs" node suture-crew/tooling/scripts/prove-sample.mjs   # local build
```

## First audit in one minute

The app bundles `samples/wholesale-quote.suture.json`, a quote model whose DuckDB pricing query adds three discounts
instead of compounding them. Each agent can reach it through the `@suture-sample` server, which is rooted at the
installed app's `samples/` folder.

1. Open **Suture Crew** in the dashboard sidebar and press **Invariant Adversary**, or ask in chat:
   *"Audit the bundled sample and give me the X-Ray link."*
2. The Exorcist finds `net-price-positive` violated. The SQL adds the three discounts instead of compounding them, so
   once they sum to 1 or more the net price is 0 or negative, and the margin cell divides by it. One shrunk
   counterexample is volume 0.4 + promo 0.4 + loyalty 0.2; the exact values vary with the random seed. The triage pane
   shows `IN → SQL → FX`, the shrunk inputs, and **Open in Suture X-Ray**. Suture's live app has this sample built in
   (**Wholesale Quote (Crew sample)** in its workbook picker), so the link opens and replays directly. Suture matches
   the workbook hash and asks you to import the `.suture.json` first only when it has no workbook with that hash, as
   with your own workspace files.
3. Press **Formula Surgeon**. It compounds the discounts in `Pricing!A1` and proves it:
   `counterexampleFixed: true`, `freshAuditPassed: true`, `regressions: 0`, with `baseValueDiffs` showing the base price
   moving from 96 to 97.47.

## Point it at your workspace

The `suture` server audits the folder named by `SUTURE_WORKSPACE`. If that is unset, it audits the folder it starts in.
MCP servers inherit the gateway's environment, so set the variable where the gateway starts:

```bash
export SUTURE_WORKSPACE=/path/to/your/models      # the folder holding your .suture.json files
kirocrew gateway
```

With Docker, pass `-e SUTURE_WORKSPACE=/models -v /path/to/your/models:/models:ro`. Workbook paths are resolved inside
that folder and cannot leave it.

Then resume the schedule: **Resume** on the dashboard's nightly-model-audit card, or the Schedule page. It runs at
02:00 in the gateway's configured timezone, with the `invariant-adversary` agent. If the workspace has no `.suture.json`
files, the job audits the bundled sample instead. Disabling and re-enabling the app resets the job to paused.

Audits of workspace files ask for approval, because `suture_run_audit` accepts `trustPython`, and trusted `=PY()` cells
run Python that can reach the file system and network. Read-only tools, the ledger write and the bundled-sample server
are auto-approved, so the job's sample audit runs unattended. A scheduled run sends each workspace audit to your
approval prompt (dashboard and Slack DM), and Kiro Crew denies a prompt nobody answers within a short window. For
fully unattended workspace audits, approve the prompts as they arrive, or switch the job to auto-approval yourself
with `kirocrew cron update <job-id> --approval-mode auto` (only you can; Kiro Crew refuses that setting from an app).
A disable and re-enable of the app registers the job again with the default approval mode.

## Architecture

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

- **Ledger** (`backend/ledger_mcp.py`): a stdio MCP server, Python standard library only. Its one tool,
  `suture_crew_record_audit`, validates a Suture report (`suture.workbooks`, `suture.audit` or `suture.verify-patch`)
  and writes it atomically to `<app>/data/reports/` under a server-generated id. It keeps the newest 500 records.
  Kiro Crew serves app-declared `agentTools` only for first-party apps, so the app ships its own MCP server.
- **Routes** (`backend/routes.py`): read-only `GET /status`, `/reports`, `/reports/{id}` hooks under
  `/api/apps/suture-crew/`, reading the same folder (`ctx.data_dir`). `SUTURE_CREW_DATA_DIR` overrides it for both.
- **Page** (`ui/`): React 18 from the host, plus `@kirocrew/app-sdk` (`useAppApi`, `useChatLauncher`, `useNotify`).
  The committed `ui/dist/index.mjs` imports only `react`, `react/jsx-runtime` and `@kirocrew/app-sdk`. If the ledger
  is empty, paste or drop a Suture report JSON to view it.

### Permissions

| Permission | Why |
|---|---|
| `api: ["/api/crons", "/api/apps/suture-crew"]` | Read, pause, resume and run the app's own cron; read the ledger |
| `cron: true` | Required by Kiro Crew for any app that declares `crons` |
| `storage: false` | The ledger writes files in the app's data folder; it does not use the key-value store |
| `network: false` | The app's code makes no requests. `npx` downloads `@g4stein/suture-mcp` once, and Pyodide may fetch NumPy for trusted `=PY()` workbooks; both belong to the engine |

## Repository layout

```
app.json                manifest
assets/icon.png         512×512 opaque store icon (tooling/scripts/gen-icon.mjs)
agents/                 schema-archaeologist, invariant-adversary, formula-surgeon
skills/                 suture-audit-playbook, suture-replay-triage
samples/                wholesale-quote.suture.json (bundled demo with a real bug)
backend/                ledger_mcp.py (MCP server + store), routes.py (gateway hooks)
ui/src, ui/dist         dashboard page source and the committed bundle
tooling/                build, tests, audits, proofs (kept out of the app root so a registry install runs no npm)
.kiro/                  steering, spec 01 (requirements, design, tasks), hooks
```

## Development and verification

```bash
cd tooling
pnpm install
pnpm run verify          # typecheck, UI build, Vitest, pytest, license audits, trademark scan
```

`pytest` needs `pip install -r tooling/requirements-dev.txt`. CI (`.github/workflows/ci.yml`) also:

- fails if rebuilding the UI changes the committed `ui/dist/index.mjs`;
- installs the app with Kiro Crew's own `install_app` and `register_app` at two pinned KiroCrew commits (the `v0.13.0`
  tag, the declared minimum, and a later main commit), then checks the registered agents, MCP servers, skills, paused
  cron, and hook routes (`tooling/crew-check/`);
- runs `tooling/scripts/prove-sample.mjs` against the published `@g4stein/suture-mcp@0.1.0` (through `npx`, as the app
  does) and against a local build from a pinned `g4stein/SUTURE` commit (the offline fallback). Each run audits the
  sample, verifies the fix with zero regressions, and records all three reports through the ledger.

Dependencies pass a license audit (no GPL, LGPL or AGPL, nothing unlicensed), and a digest-based scan keeps
third-party product names out of every file.

## License

MIT. See [LICENSE](LICENSE).
