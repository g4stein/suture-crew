import { jsxs, jsx, Fragment } from "react/jsx-runtime";
import { useAppApi, useNotify, useChatLauncher } from "@kirocrew/app-sdk";
import { useState, useCallback, useEffect, useMemo } from "react";
const APP_API = "/api/apps/suture-crew";
const CRON_NAME = "suture-crew/nightly-model-audit";
const XRAY_BASE = "https://suture-nu.vercel.app/#";
const MAX_FRAGMENT_CHARS = 8192;
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v) => typeof v === "string";
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isArr = (v) => Array.isArray(v);
class ReportError extends Error {
}
function need(cond, path, message2) {
  if (!cond) throw new ReportError(`${path} ${message2}`);
}
function isWorkbookInfo(v) {
  return isObj(v) && isStr(v["ref"]) && isStr(v["title"]) && isStr(v["hash"]) && isStr(v["python"]);
}
function parseReport(value) {
  need(isObj(value), "$", "must be a JSON object");
  need(value["version"] === 1, "$.version", "must be 1");
  const format = value["format"];
  if (format === "suture.audit") {
    need(isWorkbookInfo(value["workbook"]), "$.workbook", "must be { ref, title, hash, python }");
    need(["passed", "violated", "configError", "stopped"].includes(String(value["verdict"])), "$.verdict", "is not a Suture verdict");
    need(isNum(value["seed"]), "$.seed", "must be a number");
    for (const k of ["tier1", "tier2", "failingInputs", "lineage"]) need(isArr(value[k]), `$.${k}`, "must be an array");
    const lineage = value["lineage"];
    lineage.forEach((s, i) => need(isObj(s) && isStr(s["cell"]), `$.lineage[${i}]`, "must be { cell, dialect, value, base }"));
    const replay = value["replay"];
    need(replay === null || isObj(replay) && isObj(replay["artifact"]), "$.replay", "must be { artifact, fragment } or null");
    return value;
  }
  if (format === "suture.verify-patch") {
    need(isWorkbookInfo(value["workbook"]), "$.workbook", "must be { ref, title, hash, python }");
    need(typeof value["ok"] === "boolean", "$.ok", "must be a boolean");
    need(typeof value["freshAuditPassed"] === "boolean", "$.freshAuditPassed", "must be a boolean");
    for (const k of ["patches", "regressions", "baseValueDiffs", "patchErrors"]) need(isArr(value[k]), `$.${k}`, "must be an array");
    return value;
  }
  if (format === "suture.workbooks") {
    need(isStr(value["root"]), "$.root", "must be a string");
    need(isArr(value["flagships"]) && isArr(value["files"]), "$.files", "must be an array");
    return value;
  }
  throw new ReportError("$.format must be 'suture.workbooks', 'suture.audit' or 'suture.verify-patch'");
}
function isSummaryList(v) {
  return isObj(v) && isArr(v["records"]) && v["records"].every((r) => isObj(r) && isStr(r["id"]) && isStr(r["kind"]) && isStr(r["status"]));
}
function isLedgerRecord(v) {
  if (!isObj(v) || !isStr(v["id"]) || !isStr(v["kind"])) return false;
  try {
    parseReport(v["report"]);
    return true;
  } catch {
    return false;
  }
}
function findCron(v) {
  if (!isObj(v) || !isArr(v["jobs"])) return null;
  const job = v["jobs"].find((j) => isObj(j) && j["name"] === CRON_NAME);
  if (!isObj(job) || !isStr(job["id"]) || typeof job["enabled"] !== "boolean") return null;
  return {
    id: job["id"],
    name: CRON_NAME,
    enabled: job["enabled"],
    schedule: isStr(job["schedule"]) ? job["schedule"] : "",
    next_run_ts: isNum(job["next_run_ts"]) ? job["next_run_ts"] : null,
    last_status: isStr(job["last_status"]) ? job["last_status"] : null,
    is_running: job["is_running"] === true
  };
}
function replayUrl(fragment) {
  if (fragment === null || fragment === void 0) return null;
  if (!/^replay=v1\.[A-Za-z0-9_-]+$/.test(fragment) || fragment.length + 1 > MAX_FRAGMENT_CHARS) return null;
  return XRAY_BASE + fragment;
}
const DIALECT_LABEL = { literal: "IN", sql: "SQL", py: "PY", formula: "FX" };
function dialectLabel(d) {
  return d === null ? "—" : DIALECT_LABEL[d];
}
function lineageChain(lineage) {
  const out = [];
  for (const step of lineage) {
    const label = dialectLabel(step.dialect);
    if (out[out.length - 1] !== label) out.push(label);
  }
  return out.join(" → ");
}
function formatCell(v) {
  if (v === null) return "null";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(10)));
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if ("error" in v) return v.error;
  if ("table" in v) return `table ${v.table.rows}×${v.table.columns.length}`;
  if ("matrix" in v) return `matrix ${v.matrix.rows}×${v.matrix.cols}`;
  return "pending";
}
function buildQueue(summaries, inventories) {
  const rows = /* @__PURE__ */ new Map();
  const touch = (source, ref, title) => {
    const key = `${source}:${ref}`;
    const row = rows.get(key) ?? { ref, title, source, lastAudit: null, lastPatch: null };
    rows.set(key, row);
    return row;
  };
  for (const inv of inventories) {
    for (const f of inv.report.files) if (f.error === void 0) touch(inv.source, f.path, f.title ?? f.path);
  }
  for (const s of summaries) {
    if (s.workbook === null) continue;
    const row = touch(s.source, s.workbook.ref, s.workbook.title);
    if (s.kind === "audit" && row.lastAudit === null) row.lastAudit = s;
    if (s.kind === "patch" && row.lastPatch === null) row.lastPatch = s;
  }
  const order = { violated: 0, configError: 1, stopped: 2, unaudited: 3, passed: 4 };
  return [...rows.entries()].map(([key, r]) => {
    const st = r.lastAudit?.status;
    const status = st === "violated" || st === "passed" || st === "configError" || st === "stopped" ? st : "unaudited";
    return { key, ref: r.ref, title: r.title, source: r.source, status, lastAudit: r.lastAudit, lastPatch: r.lastPatch };
  }).sort((a, b) => order[a.status] - order[b.status] || a.ref.localeCompare(b.ref));
}
function patchChecks(p) {
  return { counterexampleFixed: p.counterexampleFixed, freshAuditPassed: p.freshAuditPassed, regressions: p.regressions.length, ok: p.ok };
}
function dispatchMessage(agent, row) {
  const target = row === null ? "the workspace (or the bundled sample if the workspace has no .suture.json files)" : `${row.ref} on the ${row.source === "sample" ? "@suture-sample" : "@suture-crew:suture"} server`;
  switch (agent) {
    case "schema-archaeologist":
      return `Map ${target}: sheets, fuzz inputs, assertions, and the SQL → PY → FX lineage of every asserted cell. Record the inventory in the ledger.`;
    case "invariant-adversary":
      return `Run the Exorcist audit on ${target}, record every report in the ledger, and give me the Suture X-Ray link for any counterexample.`;
    case "formula-surgeon":
      return `Take the latest counterexample for ${target}, find the upstream cause, and prove a non-masking fix with suture_verify_patch (0 regressions) before showing me the diff.`;
  }
}
function formatTime(ts) {
  if (ts === null) return "—";
  const d = new Date(ts * 1e3);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
const AGENTS = [
  { name: "schema-archaeologist", label: "Schema Archaeologist", blurb: "Map sheets and SQL → PY → FX lineage" },
  { name: "invariant-adversary", label: "Invariant Adversary", blurb: "Run the Exorcist and triage counterexamples" },
  { name: "formula-surgeon", label: "Formula Surgeon", blurb: "Prove a non-masking fix with 0 regressions" }
];
const STATUS_LABEL = {
  violated: "VIOLATED",
  passed: "PASSED",
  configError: "CONFIG ERROR",
  stopped: "STOPPED",
  unaudited: "NOT AUDITED",
  verified: "VERIFIED",
  rejected: "REJECTED"
};
function Badge({ status, children }) {
  return /* @__PURE__ */ jsx("span", { className: `sc-badge ${status}`, children: children ?? STATUS_LABEL[status] ?? status.toUpperCase() });
}
const sourceLabel = (s) => s === "sample" ? "bundled sample" : s === "imported" ? "imported JSON" : "workspace";
function DispatchBar({ selected, onDispatch }) {
  return /* @__PURE__ */ jsxs("section", { className: "sc-card", "aria-label": "Dispatch a Crew agent", children: [
    /* @__PURE__ */ jsxs("h2", { children: [
      "Dispatch ",
      selected === null ? "" : `· ${selected.ref}`
    ] }),
    /* @__PURE__ */ jsx("div", { className: "sc-row", children: AGENTS.map((a) => /* @__PURE__ */ jsx("button", { type: "button", className: "sc-btn", title: a.blurb, onClick: () => onDispatch(a.name), children: a.label }, a.name)) })
  ] });
}
function WorkbookQueue({ rows, selectedKey, onSelect }) {
  return /* @__PURE__ */ jsxs("section", { className: "sc-card", "aria-label": "Monitored workbooks", children: [
    /* @__PURE__ */ jsx("h2", { children: "Monitored workbooks" }),
    rows.length === 0 ? /* @__PURE__ */ jsx("p", { className: "sc-muted", children: "No reports yet. Dispatch Invariant Adversary, or resume the nightly audit, to fill this queue." }) : /* @__PURE__ */ jsx("ul", { className: "sc-list", children: rows.map((r) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsxs("button", { type: "button", className: "sc-item", "aria-pressed": r.key === selectedKey, onClick: () => onSelect(r), children: [
      /* @__PURE__ */ jsxs("span", { children: [
        r.title,
        /* @__PURE__ */ jsxs("small", { children: [
          r.ref,
          " · ",
          sourceLabel(r.source),
          r.lastAudit !== null ? ` · ${r.lastAudit.recordedAt}` : ""
        ] })
      ] }),
      /* @__PURE__ */ jsx(Badge, { status: r.status })
    ] }) }, r.key)) })
  ] });
}
function CronCard({ cron, busy, onToggle, onRunNow }) {
  return /* @__PURE__ */ jsxs("section", { className: "sc-card", "aria-label": "Nightly model audit schedule", children: [
    /* @__PURE__ */ jsx("h2", { children: "nightly-model-audit" }),
    cron === null ? /* @__PURE__ */ jsx("p", { className: "sc-muted", children: "The schedule is not registered. Enable the app to register it (it starts paused)." }) : /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsxs("div", { className: "sc-row", children: [
        /* @__PURE__ */ jsx(Badge, { status: cron.enabled ? "active" : "paused", children: cron.enabled ? "ACTIVE" : "PAUSED" }),
        cron.is_running && /* @__PURE__ */ jsx(Badge, { status: "info", children: "RUNNING" }),
        /* @__PURE__ */ jsx("span", { className: "sc-muted", children: cron.schedule })
      ] }),
      /* @__PURE__ */ jsxs("p", { className: "sc-muted", children: [
        "Next run: ",
        cron.enabled ? formatTime(cron.next_run_ts) : "paused",
        " · last result: ",
        cron.last_status ?? "never run"
      ] }),
      !cron.enabled && /* @__PURE__ */ jsx("p", { className: "sc-muted", children: "Set SUTURE_WORKSPACE for the gateway first; without .suture.json files the job audits the bundled sample." }),
      /* @__PURE__ */ jsxs("div", { className: "sc-row", children: [
        /* @__PURE__ */ jsx("button", { type: "button", className: "sc-btn primary", disabled: busy, onClick: () => onToggle(!cron.enabled), children: cron.enabled ? "Pause" : "Resume" }),
        /* @__PURE__ */ jsx("button", { type: "button", className: "sc-btn", disabled: busy || cron.is_running, onClick: onRunNow, children: "Run now" })
      ] })
    ] })
  ] });
}
function Lineage({ audit }) {
  const edge = audit.failingEdge;
  return /* @__PURE__ */ jsx("div", { className: "sc-chain", "aria-label": "Failing lineage", children: audit.lineage.map((s, i) => /* @__PURE__ */ jsxs("span", { className: "sc-row", children: [
    i > 0 && /* @__PURE__ */ jsx("span", { className: "sc-arrow", "aria-hidden": "true", children: "→" }),
    /* @__PURE__ */ jsxs("span", { className: `sc-step${edge !== null && s.cell === edge.to ? " bad" : ""}`, title: `base ${formatCell(s.base)}`, children: [
      /* @__PURE__ */ jsx("span", { className: `sc-dialect ${s.dialect ?? "literal"}`, children: dialectLabel(s.dialect) }),
      s.cell,
      " = ",
      formatCell(s.value)
    ] })
  ] }, s.cell)) });
}
function downloadArtifact(audit) {
  if (audit.replay === null) return;
  const blob = new Blob([JSON.stringify(audit.replay.artifact, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${audit.workbook.ref.replace(/[^A-Za-z0-9._-]+/g, "_")}.replay.json`;
  a.click();
  URL.revokeObjectURL(url);
}
function TriagePane({ audit, recordedAt }) {
  if (audit === null) {
    return /* @__PURE__ */ jsxs("section", { className: "sc-card", "aria-label": "Counterexample triage", children: [
      /* @__PURE__ */ jsx("h2", { children: "Counterexample triage" }),
      /* @__PURE__ */ jsx("p", { className: "sc-muted", children: "Select a workbook with an audit report." })
    ] });
  }
  const v = audit.violation;
  const link = replayUrl(audit.replay?.fragment);
  const isFile = !audit.workbook.ref.startsWith("flagship:");
  return /* @__PURE__ */ jsxs("section", { className: "sc-card", "aria-label": "Counterexample triage", children: [
    /* @__PURE__ */ jsx("h2", { children: "Counterexample triage" }),
    /* @__PURE__ */ jsxs("div", { className: "sc-row", children: [
      /* @__PURE__ */ jsx(Badge, { status: audit.verdict }),
      /* @__PURE__ */ jsx("strong", { children: audit.workbook.title }),
      /* @__PURE__ */ jsxs("span", { className: "sc-muted", children: [
        "seed ",
        audit.seed,
        " · ",
        audit.search.runs,
        " run(s)",
        recordedAt === null ? "" : ` · ${recordedAt}`
      ] })
    ] }),
    audit.verdict === "configError" && /* @__PURE__ */ jsx("p", { className: "sc-error", children: audit.message }),
    v !== null && /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsxs("p", { children: [
        "Tier ",
        v.tier,
        " ",
        /* @__PURE__ */ jsx("code", { children: v.id }),
        " ",
        v.cell === null ? "" : /* @__PURE__ */ jsxs(Fragment, { children: [
          "at ",
          /* @__PURE__ */ jsx("code", { children: v.cell }),
          " "
        ] }),
        "must be ",
        /* @__PURE__ */ jsx("code", { children: v.rule }),
        ": ",
        v.detail
      ] }),
      /* @__PURE__ */ jsxs("p", { className: "sc-muted", children: [
        "Chain: ",
        lineageChain(audit.lineage),
        audit.failingEdge === null ? "" : ` · broken edge ${audit.failingEdge.from} → ${audit.failingEdge.to}`
      ] }),
      /* @__PURE__ */ jsx(Lineage, { audit }),
      /* @__PURE__ */ jsxs("table", { children: [
        /* @__PURE__ */ jsx("caption", { className: "sc-muted", style: { textAlign: "left" }, children: "Shrunk counterexample" }),
        /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
          /* @__PURE__ */ jsx("th", { children: "Input" }),
          /* @__PURE__ */ jsx("th", { children: "Value" })
        ] }) }),
        /* @__PURE__ */ jsx("tbody", { children: audit.failingInputs.map((f) => /* @__PURE__ */ jsxs("tr", { children: [
          /* @__PURE__ */ jsx("td", { children: f.cell }),
          /* @__PURE__ */ jsx("td", { children: formatCell(f.value) })
        ] }, f.cell)) })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "sc-row", style: { marginTop: 10 }, children: [
        link !== null ? /* @__PURE__ */ jsx("a", { className: "sc-link", href: link, target: "_blank", rel: "noopener noreferrer", children: "Open in Suture X-Ray ↗" }) : /* @__PURE__ */ jsx("span", { className: "sc-muted", children: "The replay link would exceed 8,192 characters; download the replay JSON and import it in Suture." }),
        audit.replay !== null && /* @__PURE__ */ jsx("button", { type: "button", className: "sc-btn", onClick: () => downloadArtifact(audit), children: "Download replay JSON" })
      ] }),
      isFile && /* @__PURE__ */ jsxs("p", { className: "sc-muted", children: [
        "Suture asks you to import ",
        audit.workbook.ref,
        " before it replays the link (matched by workbook hash)."
      ] })
    ] }),
    /* @__PURE__ */ jsxs("details", { children: [
      /* @__PURE__ */ jsx("summary", { className: "sc-muted", children: "Tier 1 invariants and Tier 2 assertions" }),
      /* @__PURE__ */ jsx("table", { children: /* @__PURE__ */ jsxs("tbody", { children: [
        audit.tier1.map((t) => /* @__PURE__ */ jsxs("tr", { children: [
          /* @__PURE__ */ jsx("td", { children: "T1" }),
          /* @__PURE__ */ jsx("td", { children: t.id }),
          /* @__PURE__ */ jsx("td", { children: t.status })
        ] }, t.id)),
        audit.tier2.map((t) => /* @__PURE__ */ jsxs("tr", { children: [
          /* @__PURE__ */ jsx("td", { children: "T2" }),
          /* @__PURE__ */ jsxs("td", { children: [
            t.id,
            " (",
            t.cell,
            " ",
            t.rule,
            ")"
          ] }),
          /* @__PURE__ */ jsx("td", { children: t.status })
        ] }, t.id))
      ] }) })
    ] })
  ] });
}
function Check({ label, value }) {
  const cls = value === null ? "na" : value ? "ok" : "no";
  return /* @__PURE__ */ jsxs("div", { className: "sc-check", children: [
    /* @__PURE__ */ jsx("span", { className: cls, children: value === null ? "–" : value ? "✓" : "✗" }),
    /* @__PURE__ */ jsxs("code", { children: [
      label,
      ": ",
      value === null ? "null" : String(value)
    ] })
  ] });
}
function PatchPane({ patch, recordedAt }) {
  if (patch === null) {
    return /* @__PURE__ */ jsxs("section", { className: "sc-card", "aria-label": "Patch verification", children: [
      /* @__PURE__ */ jsx("h2", { children: "Patch verification" }),
      /* @__PURE__ */ jsx("p", { className: "sc-muted", children: "No verified patch for this workbook yet. Dispatch Formula Surgeon." })
    ] });
  }
  const c = patchChecks(patch);
  return /* @__PURE__ */ jsxs("section", { className: "sc-card", "aria-label": "Patch verification", children: [
    /* @__PURE__ */ jsx("h2", { children: "Patch verification" }),
    /* @__PURE__ */ jsxs("div", { className: "sc-row", children: [
      /* @__PURE__ */ jsx(Badge, { status: c.ok ? "verified" : "rejected" }),
      /* @__PURE__ */ jsxs("span", { className: "sc-muted", children: [
        "suture_verify_patch · seed ",
        patch.seed,
        recordedAt === null ? "" : ` · ${recordedAt}`
      ] })
    ] }),
    /* @__PURE__ */ jsx(Check, { label: "counterexampleFixed", value: c.counterexampleFixed }),
    /* @__PURE__ */ jsx(Check, { label: "freshAuditPassed", value: c.freshAuditPassed }),
    /* @__PURE__ */ jsx(Check, { label: `regressions: ${c.regressions}`, value: c.regressions === 0 }),
    patch.patchErrors.map((e) => /* @__PURE__ */ jsx("p", { className: "sc-error", children: e }, e)),
    patch.patches.map((p) => /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("p", { children: /* @__PURE__ */ jsx("code", { children: p.cell }) }),
      /* @__PURE__ */ jsxs("pre", { className: "before", "aria-label": "before", children: [
        "- ",
        p.before ?? "(empty)"
      ] }),
      /* @__PURE__ */ jsxs("pre", { className: "after", "aria-label": "after", children: [
        "+ ",
        p.after
      ] })
    ] }, p.cell)),
    patch.regressions.length > 0 && /* @__PURE__ */ jsxs("table", { children: [
      /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
        /* @__PURE__ */ jsx("th", { children: "Regression" }),
        /* @__PURE__ */ jsx("th", { children: "Cell" }),
        /* @__PURE__ */ jsx("th", { children: "Detail" })
      ] }) }),
      /* @__PURE__ */ jsx("tbody", { children: patch.regressions.map((r, i) => /* @__PURE__ */ jsxs("tr", { children: [
        /* @__PURE__ */ jsx("td", { children: r.kind === "assertion" ? r.id : r.code }),
        /* @__PURE__ */ jsx("td", { children: r.cell }),
        /* @__PURE__ */ jsx("td", { children: r.kind === "assertion" ? r.detail : r.message })
      ] }, `${r.cell}-${i}`)) })
    ] }),
    /* @__PURE__ */ jsxs("table", { children: [
      /* @__PURE__ */ jsx("caption", { className: "sc-muted", style: { textAlign: "left" }, children: "baseValueDiffs (base-case values the patch changes)" }),
      /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
        /* @__PURE__ */ jsx("th", { children: "Cell" }),
        /* @__PURE__ */ jsx("th", { children: "Before" }),
        /* @__PURE__ */ jsx("th", { children: "After" })
      ] }) }),
      /* @__PURE__ */ jsx("tbody", { children: patch.baseValueDiffs.map((d) => /* @__PURE__ */ jsxs("tr", { children: [
        /* @__PURE__ */ jsx("td", { children: d.cell }),
        /* @__PURE__ */ jsx("td", { children: formatCell(d.before) }),
        /* @__PURE__ */ jsx("td", { children: formatCell(d.after) })
      ] }, d.cell)) })
    ] })
  ] });
}
function ImportPanel({ onImport, error }) {
  const [text, setText] = useState("");
  return /* @__PURE__ */ jsx("section", { className: "sc-card", "aria-label": "Import a Suture report", children: /* @__PURE__ */ jsxs("details", { children: [
    /* @__PURE__ */ jsx("summary", { className: "sc-muted", children: "Paste or drop a Suture report (suture.audit, suture.verify-patch, suture.workbooks)" }),
    /* @__PURE__ */ jsx(
      "textarea",
      {
        "aria-label": "Suture report JSON",
        value: text,
        placeholder: '{"format": "suture.audit", ...}',
        onChange: (e) => setText(e.target.value),
        onDragOver: (e) => e.preventDefault(),
        onDrop: (e) => {
          e.preventDefault();
          const file = e.dataTransfer.files[0];
          if (file !== void 0) void file.text().then(setText);
        }
      }
    ),
    /* @__PURE__ */ jsxs("div", { className: "sc-row", children: [
      /* @__PURE__ */ jsx("button", { type: "button", className: "sc-btn", disabled: text.trim() === "", onClick: () => onImport(text), children: "Show report" }),
      error !== null && /* @__PURE__ */ jsx("span", { className: "sc-error", role: "alert", children: error })
    ] }),
    /* @__PURE__ */ jsx("p", { className: "sc-muted", children: "Imported reports are shown on this page only; agents record reports in the ledger." })
  ] }) });
}
function Dashboard(p) {
  return /* @__PURE__ */ jsxs("div", { className: "sc", children: [
    /* @__PURE__ */ jsxs("header", { className: "sc-head", children: [
      /* @__PURE__ */ jsx("h1", { children: "Suture Crew" }),
      /* @__PURE__ */ jsxs(Badge, { status: "info", children: [
        p.records,
        " record(s)"
      ] }),
      /* @__PURE__ */ jsx("button", { type: "button", className: "sc-btn", onClick: p.onRefresh, children: "Refresh" }),
      /* @__PURE__ */ jsx("p", { children: "Autonomous Exorcist audits for .suture.json models, verified patches, and Suture X-Ray replay links." })
    ] }),
    p.loadError !== null && /* @__PURE__ */ jsx("p", { className: "sc-error", role: "alert", children: p.loadError }),
    /* @__PURE__ */ jsxs("div", { className: "sc-grid", children: [
      /* @__PURE__ */ jsxs("div", { className: "sc-stack", children: [
        /* @__PURE__ */ jsx(DispatchBar, { selected: p.selected, onDispatch: p.onDispatch }),
        /* @__PURE__ */ jsx(WorkbookQueue, { rows: p.rows, selectedKey: p.selected?.key ?? null, onSelect: p.onSelect }),
        /* @__PURE__ */ jsx(CronCard, { cron: p.cron, busy: p.cronBusy, onToggle: p.onToggleCron, onRunNow: p.onRunCron })
      ] }),
      /* @__PURE__ */ jsxs("div", { className: "sc-stack", children: [
        /* @__PURE__ */ jsx(TriagePane, { audit: p.audit, recordedAt: p.auditAt }),
        /* @__PURE__ */ jsx(PatchPane, { patch: p.patch, recordedAt: p.patchAt }),
        /* @__PURE__ */ jsx(ImportPanel, { onImport: p.onImport, error: p.importError })
      ] })
    ] })
  ] });
}
const TOKENS = {
  obsidian: "#090B10",
  panel: "#10141D",
  raised: "#171C28",
  cyan: "#06B6D4",
  emerald: "#10B981",
  amber: "#F59E0B",
  crimson: "#F43F5E",
  text: "#E2E8F0",
  muted: "#94A3B8"
};
const CSS = `
.sc { --sc-obsidian:${TOKENS.obsidian}; --sc-panel:${TOKENS.panel}; --sc-raised:${TOKENS.raised}; --sc-cyan:${TOKENS.cyan};
  --sc-emerald:${TOKENS.emerald}; --sc-amber:${TOKENS.amber}; --sc-crimson:${TOKENS.crimson}; --sc-text:${TOKENS.text}; --sc-muted:${TOKENS.muted};
  background:var(--sc-obsidian); color:var(--sc-text); min-height:100%; flex:1; overflow-y:auto; padding:20px 24px 32px;
  font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace; box-sizing:border-box; }
.sc *, .sc *::before, .sc *::after { box-sizing:inherit; }
.sc h1 { font-size:18px; margin:0; letter-spacing:.02em; }
.sc h2 { font-size:12px; margin:0 0 10px; text-transform:uppercase; letter-spacing:.08em; color:var(--sc-muted); font-weight:600; }
.sc-head { display:flex; align-items:center; gap:12px; flex-wrap:wrap; margin-bottom:16px; }
.sc-head p { margin:0; color:var(--sc-muted); flex-basis:100%; }
.sc-grid { display:grid; gap:14px; grid-template-columns:minmax(260px,1fr) minmax(320px,1.4fr); }
@media (max-width:900px) { .sc-grid { grid-template-columns:1fr; } }
.sc-card { background:var(--sc-panel); border:1px solid var(--sc-raised); border-radius:10px; padding:14px; min-width:0; }
.sc-stack { display:flex; flex-direction:column; gap:14px; min-width:0; }
.sc-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
.sc-btn { background:var(--sc-raised); color:var(--sc-text); border:1px solid #232a3a; border-radius:6px; padding:6px 10px; font:inherit; cursor:pointer; }
.sc-btn:hover { border-color:var(--sc-cyan); }
.sc-btn:focus-visible, .sc a:focus-visible, .sc-item:focus-visible { outline:2px solid var(--sc-cyan); outline-offset:2px; }
.sc-btn[disabled] { opacity:.5; cursor:not-allowed; }
.sc-btn.primary { background:var(--sc-cyan); color:var(--sc-obsidian); border-color:var(--sc-cyan); font-weight:700; }
.sc-badge { display:inline-block; border-radius:999px; padding:1px 8px; font-size:11px; font-weight:700; border:1px solid currentColor; white-space:nowrap; }
.sc-badge.violated, .sc-badge.rejected { color:var(--sc-crimson); }
.sc-badge.passed, .sc-badge.verified { color:var(--sc-emerald); }
.sc-badge.configError, .sc-badge.stopped, .sc-badge.paused { color:var(--sc-amber); }
.sc-badge.unaudited, .sc-badge.info { color:var(--sc-muted); }
.sc-badge.active { color:var(--sc-cyan); }
.sc-list { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:6px; }
.sc-item { width:100%; text-align:left; display:flex; justify-content:space-between; gap:8px; align-items:center; background:transparent;
  border:1px solid var(--sc-raised); border-radius:8px; padding:8px 10px; color:inherit; font:inherit; cursor:pointer; }
.sc-item[aria-pressed="true"] { border-color:var(--sc-cyan); background:#0c1a22; }
.sc-item small { color:var(--sc-muted); display:block; }
.sc-muted { color:var(--sc-muted); }
.sc-chain { display:flex; flex-wrap:wrap; gap:4px; align-items:center; margin:8px 0; }
.sc-step { border:1px solid var(--sc-raised); border-radius:6px; padding:4px 6px; background:var(--sc-obsidian); }
.sc-step.bad { border-color:var(--sc-crimson); }
.sc-dialect { font-size:10px; font-weight:700; margin-right:4px; }
.sc-dialect.sql { color:var(--sc-cyan); } .sc-dialect.py { color:var(--sc-amber); } .sc-dialect.formula { color:var(--sc-emerald); } .sc-dialect.literal { color:var(--sc-muted); }
.sc-arrow { color:var(--sc-muted); }
.sc table { width:100%; border-collapse:collapse; font-size:12px; }
.sc th, .sc td { text-align:left; padding:4px 6px; border-bottom:1px solid var(--sc-raised); vertical-align:top; }
.sc th { color:var(--sc-muted); font-weight:600; }
.sc code, .sc pre { background:var(--sc-obsidian); border:1px solid var(--sc-raised); border-radius:4px; }
.sc code { padding:0 4px; }
.sc pre { padding:8px; margin:4px 0; white-space:pre-wrap; word-break:break-all; }
.sc pre.before { border-left:3px solid var(--sc-crimson); } .sc pre.after { border-left:3px solid var(--sc-emerald); }
.sc a.sc-link { color:var(--sc-cyan); font-weight:700; }
.sc-check { display:flex; gap:6px; align-items:baseline; }
.sc-check .ok { color:var(--sc-emerald); } .sc-check .no { color:var(--sc-crimson); } .sc-check .na { color:var(--sc-muted); }
.sc textarea { width:100%; min-height:90px; background:var(--sc-obsidian); color:var(--sc-text); border:1px solid var(--sc-raised); border-radius:6px; font:inherit; padding:8px; }
.sc-error { color:var(--sc-crimson); }
`;
const POLL_MS = 15e3;
function message(e) {
  return e instanceof Error ? e.message : String(e);
}
function SutureCrewPage() {
  const api = useAppApi();
  const notify = useNotify();
  const { openChat } = useChatLauncher();
  const [summaries, setSummaries] = useState([]);
  const [inventories, setInventories] = useState([]);
  const [cron, setCron] = useState(null);
  const [cronBusy, setCronBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState(null);
  const [records, setRecords] = useState({});
  const [imported, setImported] = useState({ audit: null, patch: null });
  const [loadError, setLoadError] = useState(null);
  const [importError, setImportError] = useState(null);
  const fetchRecord = useCallback(async (id) => {
    const r = await api.get(`${APP_API}/reports/${encodeURIComponent(id)}`);
    return isLedgerRecord(r) ? r : null;
  }, [api]);
  const load = useCallback(async () => {
    try {
      const [list, crons] = await Promise.all([api.get(`${APP_API}/reports`), api.get("/api/crons")]);
      if (!isSummaryList(list)) throw new Error("the ledger answered with an unexpected shape");
      setSummaries(list.records);
      setCron(findCron(crons));
      const latest = /* @__PURE__ */ new Map();
      for (const s of list.records) if (s.kind === "workbooks" && !latest.has(s.source)) latest.set(s.source, s);
      const inv = [];
      for (const [source, s] of latest) {
        const rec = await fetchRecord(s.id);
        if (rec !== null && rec.report.format === "suture.workbooks") inv.push({ source, report: rec.report });
      }
      setInventories(inv);
      setLoadError(null);
    } catch (e) {
      setLoadError(`Could not load the ledger: ${message(e)}`);
    }
  }, [api, fetchRecord]);
  useEffect(() => {
    void load();
    const t = setInterval(() => {
      void load();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);
  const rows = useMemo(() => buildQueue(summaries, inventories), [summaries, inventories]);
  const selected = rows.find((r) => r.key === selectedKey) ?? rows[0] ?? null;
  useEffect(() => {
    const ids = [selected?.lastAudit?.id, selected?.lastPatch?.id].filter((id) => id !== void 0 && records[id] === void 0);
    if (ids.length === 0) return;
    let live = true;
    void Promise.all(ids.map(fetchRecord)).then((got) => {
      if (!live) return;
      setRecords((prev) => {
        const next = { ...prev };
        for (const r of got) if (r !== null) next[r.id] = r;
        return next;
      });
    }).catch((e) => {
      if (live) setLoadError(`Could not load a report: ${message(e)}`);
    });
    return () => {
      live = false;
    };
  }, [selected?.lastAudit?.id, selected?.lastPatch?.id, records, fetchRecord]);
  const auditRec = selected?.lastAudit ? records[selected.lastAudit.id] : void 0;
  const patchRec = selected?.lastPatch ? records[selected.lastPatch.id] : void 0;
  const audit = imported.audit ?? (auditRec?.report.format === "suture.audit" ? auditRec.report : null);
  const patch = imported.patch ?? (patchRec?.report.format === "suture.verify-patch" ? patchRec.report : null);
  const toggleCron = useCallback(async (enabled) => {
    if (cron === null) return;
    setCronBusy(true);
    try {
      await api.post(`/api/crons/${encodeURIComponent(cron.id)}/enable`, { enabled });
      notify(enabled ? "nightly-model-audit resumed" : "nightly-model-audit paused", { type: "success" });
      await load();
    } catch (e) {
      notify(`Could not update the schedule: ${message(e)}`, { type: "error" });
    } finally {
      setCronBusy(false);
    }
  }, [api, cron, load, notify]);
  const runCron = useCallback(async () => {
    if (cron === null) return;
    setCronBusy(true);
    try {
      await api.post(`/api/crons/${encodeURIComponent(cron.id)}/run`);
      notify("nightly-model-audit started", { type: "success" });
      await load();
    } catch (e) {
      notify(`Could not start the audit: ${message(e)}`, { type: "error" });
    } finally {
      setCronBusy(false);
    }
  }, [api, cron, load, notify]);
  const dispatch = useCallback((agent) => {
    openChat({ agent, message: dispatchMessage(agent, selected) });
  }, [openChat, selected]);
  const importReport = useCallback((text) => {
    try {
      const report = parseReport(JSON.parse(text));
      if (report.format === "suture.audit") setImported((p) => ({ ...p, audit: report }));
      else if (report.format === "suture.verify-patch") setImported((p) => ({ ...p, patch: report }));
      else setInventories((prev) => [...prev.filter((i) => i.source !== "imported"), { source: "imported", report }]);
      setImportError(null);
    } catch (e) {
      setImportError(e instanceof ReportError || e instanceof SyntaxError ? e.message : message(e));
    }
  }, []);
  const select = useCallback((row) => {
    setSelectedKey(row.key);
    setImported({ audit: null, patch: null });
  }, []);
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("style", { children: CSS }),
    /* @__PURE__ */ jsx(
      Dashboard,
      {
        rows,
        selected,
        audit,
        auditAt: imported.audit !== null ? "imported" : auditRec?.recordedAt ?? null,
        patch,
        patchAt: imported.patch !== null ? "imported" : patchRec?.recordedAt ?? null,
        cron,
        cronBusy,
        loadError,
        importError,
        records: summaries.length,
        onSelect: select,
        onRefresh: () => {
          void load();
        },
        onToggleCron: (enabled) => {
          void toggleCron(enabled);
        },
        onRunCron: () => {
          void runCron();
        },
        onDispatch: dispatch,
        onImport: importReport
      }
    )
  ] });
}
export {
  SutureCrewPage as default
};
