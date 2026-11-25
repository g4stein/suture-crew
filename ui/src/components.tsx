/**
 * Presentational components for the Suture Crew page. They take data and callbacks as props and import nothing from the
 * host SDK, so they render the same inside Kiro Crew and under the Vitest server renderer.
 */
import { useState, type ReactNode } from 'react';
import {
  dialectLabel,
  formatCell,
  formatTime,
  lineageChain,
  patchChecks,
  replayUrl,
  type AgentName,
  type AuditReport,
  type CronJob,
  type PatchReport,
  type QueueRow,
  type Source,
} from './model.ts';

export const AGENTS: ReadonlyArray<{ readonly name: AgentName; readonly label: string; readonly blurb: string }> = [
  { name: 'schema-archaeologist', label: 'Schema Archaeologist', blurb: 'Map sheets and SQL → PY → FX lineage' },
  { name: 'invariant-adversary', label: 'Invariant Adversary', blurb: 'Run the Exorcist and triage counterexamples' },
  { name: 'formula-surgeon', label: 'Formula Surgeon', blurb: 'Prove a non-masking fix with 0 regressions' },
];

const STATUS_LABEL: Readonly<Record<string, string>> = {
  violated: 'VIOLATED',
  passed: 'PASSED',
  configError: 'CONFIG ERROR',
  stopped: 'STOPPED',
  unaudited: 'NOT AUDITED',
  verified: 'VERIFIED',
  rejected: 'REJECTED',
};

export function Badge({ status, children }: { readonly status: string; readonly children?: ReactNode }) {
  return <span className={`sc-badge ${status}`}>{children ?? STATUS_LABEL[status] ?? status.toUpperCase()}</span>;
}

const sourceLabel = (s: Source): string => (s === 'sample' ? 'bundled sample' : s === 'imported' ? 'imported JSON' : 'workspace');

export function DispatchBar({ selected, onDispatch }: { readonly selected: QueueRow | null; readonly onDispatch: (agent: AgentName) => void }) {
  return (
    <section className="sc-card" aria-label="Dispatch a Crew agent">
      <h2>Dispatch {selected === null ? '' : `· ${selected.ref}`}</h2>
      <div className="sc-row">
        {AGENTS.map((a) => (
          <button key={a.name} type="button" className="sc-btn" title={a.blurb} onClick={() => onDispatch(a.name)}>
            {a.label}
          </button>
        ))}
      </div>
    </section>
  );
}

export function WorkbookQueue({ rows, selectedKey, onSelect }: { readonly rows: ReadonlyArray<QueueRow>; readonly selectedKey: string | null; readonly onSelect: (row: QueueRow) => void }) {
  return (
    <section className="sc-card" aria-label="Monitored workbooks">
      <h2>Monitored workbooks</h2>
      {rows.length === 0 ? (
        <p className="sc-muted">No reports yet. Dispatch Invariant Adversary, or resume the nightly audit, to fill this queue.</p>
      ) : (
        <ul className="sc-list">
          {rows.map((r) => (
            <li key={r.key}>
              <button type="button" className="sc-item" aria-pressed={r.key === selectedKey} onClick={() => onSelect(r)}>
                <span>
                  {r.title}
                  <small>
                    {r.ref} · {sourceLabel(r.source)}
                    {r.lastAudit !== null ? ` · ${r.lastAudit.recordedAt}` : ''}
                  </small>
                </span>
                <Badge status={r.status} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function CronCard({ cron, busy, onToggle, onRunNow }: { readonly cron: CronJob | null; readonly busy: boolean; readonly onToggle: (enabled: boolean) => void; readonly onRunNow: () => void }) {
  return (
    <section className="sc-card" aria-label="Nightly model audit schedule">
      <h2>nightly-model-audit</h2>
      {cron === null ? (
        <p className="sc-muted">The schedule is not registered. Enable the app to register it (it starts paused).</p>
      ) : (
        <>
          <div className="sc-row">
            <Badge status={cron.enabled ? 'active' : 'paused'}>{cron.enabled ? 'ACTIVE' : 'PAUSED'}</Badge>
            {cron.is_running && <Badge status="info">RUNNING</Badge>}
            <span className="sc-muted">{cron.schedule}</span>
          </div>
          <p className="sc-muted">
            Next run: {cron.enabled ? formatTime(cron.next_run_ts) : 'paused'} · last result: {cron.last_status ?? 'never run'}
          </p>
          {!cron.enabled && <p className="sc-muted">Set SUTURE_WORKSPACE for the gateway first; without .suture.json files the job audits the bundled sample.</p>}
          <div className="sc-row">
            <button type="button" className="sc-btn primary" disabled={busy} onClick={() => onToggle(!cron.enabled)}>
              {cron.enabled ? 'Pause' : 'Resume'}
            </button>
            <button type="button" className="sc-btn" disabled={busy || cron.is_running} onClick={onRunNow}>
              Run now
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function Lineage({ audit }: { readonly audit: AuditReport }) {
  const edge = audit.failingEdge;
  return (
    <div className="sc-chain" aria-label="Failing lineage">
      {audit.lineage.map((s, i) => (
        <span key={s.cell} className="sc-row">
          {i > 0 && <span className="sc-arrow" aria-hidden="true">→</span>}
          <span className={`sc-step${edge !== null && (s.cell === edge.to) ? ' bad' : ''}`} title={`base ${formatCell(s.base)}`}>
            <span className={`sc-dialect ${s.dialect ?? 'literal'}`}>{dialectLabel(s.dialect)}</span>
            {s.cell} = {formatCell(s.value)}
          </span>
        </span>
      ))}
    </div>
  );
}

function downloadArtifact(audit: AuditReport): void {
  if (audit.replay === null) return;
  const blob = new Blob([JSON.stringify(audit.replay.artifact, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${audit.workbook.ref.replace(/[^A-Za-z0-9._-]+/g, '_')}.replay.json`;
  a.click();
  // Revoke after the click's download has started; revoking synchronously can cancel it in some browsers.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function TriagePane({ audit, recordedAt }: { readonly audit: AuditReport | null; readonly recordedAt: string | null }) {
  if (audit === null) {
    return (
      <section className="sc-card" aria-label="Counterexample triage">
        <h2>Counterexample triage</h2>
        <p className="sc-muted">Select a workbook with an audit report.</p>
      </section>
    );
  }
  const v = audit.violation;
  const link = replayUrl(audit.replay?.fragment);
  const isFile = !audit.workbook.ref.startsWith('flagship:');
  return (
    <section className="sc-card" aria-label="Counterexample triage">
      <h2>Counterexample triage</h2>
      <div className="sc-row">
        <Badge status={audit.verdict} />
        <strong>{audit.workbook.title}</strong>
        <span className="sc-muted">seed {audit.seed} · {audit.search.runs} run(s){recordedAt === null ? '' : ` · ${recordedAt}`}</span>
      </div>
      {audit.verdict === 'configError' && <p className="sc-error">{audit.message}</p>}
      {v !== null && (
        <>
          <p>
            Tier {v.tier} <code>{v.id}</code> {v.cell === null ? '' : <>at <code>{v.cell}</code> </>}must be <code>{v.rule}</code>: {v.detail}
          </p>
          <p className="sc-muted">Chain: {lineageChain(audit.lineage)}{audit.failingEdge === null ? '' : ` · broken edge ${audit.failingEdge.from} → ${audit.failingEdge.to}`}</p>
          <Lineage audit={audit} />
          <table>
            <caption className="sc-muted" style={{ textAlign: 'left' }}>Shrunk counterexample</caption>
            <thead><tr><th>Input</th><th>Value</th></tr></thead>
            <tbody>
              {audit.failingInputs.map((f) => (
                <tr key={f.cell}><td>{f.cell}</td><td>{formatCell(f.value)}</td></tr>
              ))}
            </tbody>
          </table>
          <div className="sc-row" style={{ marginTop: 10 }}>
            {link !== null ? (
              <a className="sc-link" href={link} target="_blank" rel="noopener noreferrer">Open in Suture X-Ray ↗</a>
            ) : (
              <span className="sc-muted">The replay link would exceed 8,192 characters; download the replay JSON and import it in Suture.</span>
            )}
            {audit.replay !== null && (
              <button type="button" className="sc-btn" onClick={() => downloadArtifact(audit)}>Download replay JSON</button>
            )}
          </div>
          {isFile && <p className="sc-muted">Suture replays this link directly when it already has a workbook with this hash (the bundled sample is built in). Otherwise it asks you to import {audit.workbook.ref} first.</p>}
        </>
      )}
      <details>
        <summary className="sc-muted">Tier 1 invariants and Tier 2 assertions</summary>
        <table>
          <tbody>
            {audit.tier1.map((t) => (<tr key={t.id}><td>T1</td><td>{t.id}</td><td>{t.status}</td></tr>))}
            {audit.tier2.map((t) => (<tr key={t.id}><td>T2</td><td>{t.id} ({t.cell} {t.rule})</td><td>{t.status}</td></tr>))}
          </tbody>
        </table>
      </details>
    </section>
  );
}

function Check({ label, value }: { readonly label: string; readonly value: boolean | null }) {
  const cls = value === null ? 'na' : value ? 'ok' : 'no';
  return (
    <div className="sc-check">
      <span className={cls}>{value === null ? '–' : value ? '✓' : '✗'}</span>
      <code>{label}: {value === null ? 'null' : String(value)}</code>
    </div>
  );
}

export function PatchPane({ patch, recordedAt }: { readonly patch: PatchReport | null; readonly recordedAt: string | null }) {
  if (patch === null) {
    return (
      <section className="sc-card" aria-label="Patch verification">
        <h2>Patch verification</h2>
        <p className="sc-muted">No verified patch for this workbook yet. Dispatch Formula Surgeon.</p>
      </section>
    );
  }
  const c = patchChecks(patch);
  return (
    <section className="sc-card" aria-label="Patch verification">
      <h2>Patch verification</h2>
      <div className="sc-row">
        <Badge status={c.ok ? 'verified' : 'rejected'} />
        <span className="sc-muted">suture_verify_patch · seed {patch.seed}{recordedAt === null ? '' : ` · ${recordedAt}`}</span>
      </div>
      <Check label="counterexampleFixed" value={c.counterexampleFixed} />
      <Check label="freshAuditPassed" value={c.freshAuditPassed} />
      <Check label={`regressions: ${c.regressions}`} value={c.regressions === 0} />
      {patch.patchErrors.map((e) => (<p key={e} className="sc-error">{e}</p>))}
      {patch.patches.map((p) => (
        <div key={p.cell}>
          <p><code>{p.cell}</code></p>
          <pre className="before" aria-label="before">- {p.before ?? '(empty)'}</pre>
          <pre className="after" aria-label="after">+ {p.after}</pre>
        </div>
      ))}
      {patch.regressions.length > 0 && (
        <table>
          <thead><tr><th>Regression</th><th>Cell</th><th>Detail</th></tr></thead>
          <tbody>
            {patch.regressions.map((r, i) => (
              <tr key={`${r.cell}-${i}`}><td>{r.kind === 'assertion' ? r.id : r.code}</td><td>{r.cell}</td><td>{r.kind === 'assertion' ? r.detail : r.message}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      <table>
        <caption className="sc-muted" style={{ textAlign: 'left' }}>baseValueDiffs (base-case values the patch changes)</caption>
        <thead><tr><th>Cell</th><th>Before</th><th>After</th></tr></thead>
        <tbody>
          {patch.baseValueDiffs.map((d) => (
            <tr key={d.cell}><td>{d.cell}</td><td>{formatCell(d.before)}</td><td>{formatCell(d.after)}</td></tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export function ImportPanel({ onImport, error }: { readonly onImport: (text: string) => void; readonly error: string | null }) {
  const [text, setText] = useState('');
  return (
    <section className="sc-card" aria-label="Import a Suture report">
      <details>
        <summary className="sc-muted">Paste or drop a Suture report (suture.audit, suture.verify-patch, suture.workbooks)</summary>
        <textarea
          aria-label="Suture report JSON"
          value={text}
          placeholder='{"format": "suture.audit", ...}'
          onChange={(e) => setText(e.target.value)}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files[0];
            if (file !== undefined) void file.text().then(setText);
          }}
        />
        <div className="sc-row">
          <button type="button" className="sc-btn" disabled={text.trim() === ''} onClick={() => onImport(text)}>Show report</button>
          {error !== null && <span className="sc-error" role="alert">{error}</span>}
        </div>
        <p className="sc-muted">Imported reports are shown on this page only; agents record reports in the ledger.</p>
      </details>
    </section>
  );
}

export interface DashboardProps {
  readonly rows: ReadonlyArray<QueueRow>;
  readonly selected: QueueRow | null;
  readonly audit: AuditReport | null;
  readonly auditAt: string | null;
  readonly patch: PatchReport | null;
  readonly patchAt: string | null;
  readonly cron: CronJob | null;
  readonly cronBusy: boolean;
  readonly loadError: string | null;
  readonly importError: string | null;
  readonly records: number;
  readonly onSelect: (row: QueueRow) => void;
  readonly onRefresh: () => void;
  readonly onToggleCron: (enabled: boolean) => void;
  readonly onRunCron: () => void;
  readonly onDispatch: (agent: AgentName) => void;
  readonly onImport: (text: string) => void;
}

export function Dashboard(p: DashboardProps) {
  return (
    <div className="sc">
      <header className="sc-head">
        <h1>Suture Crew</h1>
        <Badge status="info">{p.records} record(s)</Badge>
        <button type="button" className="sc-btn" onClick={p.onRefresh}>Refresh</button>
        <p>Autonomous Exorcist audits for .suture.json models, verified patches, and Suture X-Ray replay links.</p>
      </header>
      {p.loadError !== null && <p className="sc-error" role="alert">{p.loadError}</p>}
      <div className="sc-grid">
        <div className="sc-stack">
          <DispatchBar selected={p.selected} onDispatch={p.onDispatch} />
          <WorkbookQueue rows={p.rows} selectedKey={p.selected?.key ?? null} onSelect={p.onSelect} />
          <CronCard cron={p.cron} busy={p.cronBusy} onToggle={p.onToggleCron} onRunNow={p.onRunCron} />
        </div>
        <div className="sc-stack">
          <TriagePane audit={p.audit} recordedAt={p.auditAt} />
          <PatchPane patch={p.patch} recordedAt={p.patchAt} />
          <ImportPanel onImport={p.onImport} error={p.importError} />
        </div>
      </div>
    </div>
  );
}
