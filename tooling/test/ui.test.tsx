// The page's model functions and presentational components, rendered with React's server renderer against the real
// Suture reports in tooling/fixtures/ (captured by scripts/prove-sample.mjs --write-fixtures).
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Dashboard, PatchPane, TriagePane, WorkbookQueue } from '@ui/components.tsx';
import {
  buildQueue,
  dispatchMessage,
  findCron,
  formatCell,
  isLedgerRecord,
  isSummaryList,
  lineageChain,
  parseReport,
  replayUrl,
  ReportError,
  type AuditReport,
  type PatchReport,
  type Report,
  type Summary,
  type WorkbooksReport,
} from '@ui/model.ts';
import { readJson } from './helpers.ts';

function load<F extends Report['format']>(file: string, format: F): Extract<Report, { format: F }> {
  const r = parseReport(readJson('tooling', 'fixtures', file));
  if (r.format !== format) throw new Error(`${file} is ${r.format}, expected ${format}`);
  return r as Extract<Report, { format: F }>;
}

const audit: AuditReport = load('audit.json', 'suture.audit');
const patch: PatchReport = load('verify-patch.json', 'suture.verify-patch');
const workbooks: WorkbooksReport = load('workbooks.json', 'suture.workbooks');

const auditSummary: Summary = {
  id: '20261121T120000Z-audit-0123456789ab', kind: 'audit', recordedAt: '2026-11-21T12:00:00Z', source: 'sample', agent: 'invariant-adversary',
  workbook: { ref: audit.workbook.ref, title: audit.workbook.title, hash: audit.workbook.hash }, status: 'violated', detail: 'net-price-positive',
  replayUrl: replayUrl(audit.replay?.fragment),
};
const patchSummary: Summary = { ...auditSummary, id: '20261121T120500Z-patch-0123456789ab', kind: 'patch', recordedAt: '2026-11-21T12:05:00Z', status: 'verified', detail: '0 regression(s)', replayUrl: null };

describe('model', () => {
  it('parses the three real Suture report formats and rejects others with the failing field', () => {
    expect([audit.format, patch.format, workbooks.format]).toEqual(['suture.audit', 'suture.verify-patch', 'suture.workbooks']);
    expect(() => parseReport({ format: 'suture.audit', version: 1 })).toThrow(ReportError);
    expect(() => parseReport({ format: 'other', version: 1 })).toThrow(/\$\.format/);
    expect(() => parseReport([])).toThrow(/\$ must be a JSON object/);
  });

  it('builds X-Ray links only from well-formed fragments that fit in a URL', () => {
    expect(replayUrl(audit.replay?.fragment)).toBe(`https://suture-nu.vercel.app/#${audit.replay?.fragment ?? ''}`);
    expect(replayUrl(null)).toBeNull();
    expect(replayUrl('replay=v1.abc"><script>')).toBeNull();
    expect(replayUrl(`replay=v1.${'a'.repeat(8200)}`)).toBeNull();
  });

  it('labels the failing lineage chain by dialect', () => {
    expect(lineageChain(audit.lineage)).toBe('IN → SQL → FX');
    expect(lineageChain([
      { cell: 'A!A1', dialect: 'literal', value: 1, base: 1 }, { cell: 'A!A2', dialect: 'sql', value: 1, base: 1 },
      { cell: 'A!A3', dialect: 'py', value: 1, base: 1 }, { cell: 'A!A4', dialect: 'formula', value: 1, base: 1 },
    ])).toBe('IN → SQL → PY → FX');
  });

  it('formats Suture cell values', () => {
    expect(formatCell(0.30000000000000004)).toBe('0.3');
    expect(formatCell({ error: '#DIV/0!', message: 'm', origin: 'Q!B4', engine: 'formula' })).toBe('#DIV/0!');
    expect(formatCell({ table: { rows: 12, columns: ['a', 'b'] } })).toBe('table 12×2');
    expect(formatCell(null)).toBe('null');
  });

  it('builds the monitored queue from inventories and summaries, violations first', () => {
    const rows = buildQueue([patchSummary, auditSummary], [{ source: 'sample', report: workbooks }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('violated');
    expect(rows[0]?.lastAudit?.id).toBe(auditSummary.id);
    expect(rows[0]?.lastPatch?.id).toBe(patchSummary.id);
    const unaudited = buildQueue([], [{ source: 'workspace', report: workbooks }]);
    expect(unaudited[0]?.status).toBe('unaudited');
  });

  it('finds the app cron in the /api/crons response', () => {
    const cron = findCron({ jobs: [{ id: 'x', name: 'other', enabled: true }, { id: 'j1', name: 'suture-crew/nightly-model-audit', enabled: false, schedule: 'cron 0 2 * * *', next_run_ts: null, is_running: false }] });
    expect(cron).toMatchObject({ id: 'j1', enabled: false, schedule: 'cron 0 2 * * *' });
    expect(findCron({ jobs: [] })).toBeNull();
    expect(findCron('nope')).toBeNull();
  });

  it('guards the ledger route responses', () => {
    expect(isSummaryList({ records: [auditSummary] })).toBe(true);
    expect(isSummaryList({ records: [{}] })).toBe(false);
    expect(isLedgerRecord({ id: auditSummary.id, kind: 'audit', report: audit })).toBe(true);
    expect(isLedgerRecord({ id: auditSummary.id, kind: 'audit', report: { format: 'x' } })).toBe(false);
  });

  it('writes a dispatch message naming the workbook and server', () => {
    const [row] = buildQueue([auditSummary], []);
    expect(dispatchMessage('formula-surgeon', row ?? null)).toContain('wholesale-quote.suture.json on the @suture-sample server');
    expect(dispatchMessage('invariant-adversary', null)).toContain('bundled sample');
  });
});

describe('components', () => {
  it('triage pane shows the counterexample, chain, shrunk inputs and the X-Ray link', () => {
    const html = renderToStaticMarkup(<TriagePane audit={audit} recordedAt="2026-11-21T12:00:00Z" />);
    expect(html).toContain('VIOLATED');
    expect(html).toContain('net-price-positive');
    expect(html).toContain('IN → SQL → FX');
    expect(html).toContain('broken edge Pricing!A1 → Quote!B2');
    for (const f of audit.failingInputs) expect(html).toContain(f.cell);
    expect(html).toContain(`href="https://suture-nu.vercel.app/#${audit.replay?.fragment ?? ''}"`);
    expect(html).toContain('Open in Suture X-Ray');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('import wholesale-quote.suture.json');
  });

  it('triage pane explains a missing link', () => {
    const noLink: AuditReport = { ...audit, replay: audit.replay === null ? null : { artifact: audit.replay.artifact, fragment: null } };
    const html = renderToStaticMarkup(<TriagePane audit={noLink} recordedAt={null} />);
    expect(html).not.toContain('Open in Suture X-Ray');
    expect(html).toContain('exceed 8,192 characters');
  });

  it('patch pane shows the four verification checks, the diff and baseValueDiffs', () => {
    const html = renderToStaticMarkup(<PatchPane patch={patch} recordedAt={null} />);
    expect(html).toContain('VERIFIED');
    expect(html).toContain('counterexampleFixed: true');
    expect(html).toContain('freshAuditPassed: true');
    expect(html).toContain('regressions: 0');
    expect(html).toContain('baseValueDiffs');
    expect(html).toContain('Pricing!A1');
    expect(html).toContain('97.47');
  });

  it('patch pane marks a rejected patch', () => {
    const bad: PatchReport = { ...patch, ok: false, freshAuditPassed: false, regressions: [{ kind: 'newError', cell: 'Quote!B4', code: '#DIV/0!', message: 'division by zero' }] };
    const html = renderToStaticMarkup(<PatchPane patch={bad} recordedAt={null} />);
    expect(html).toContain('REJECTED');
    expect(html).toContain('regressions: 1');
    expect(html).toContain('#DIV/0!');
  });

  it('queue shows each workbook with its badge', () => {
    const rows = buildQueue([auditSummary], [{ source: 'sample', report: workbooks }]);
    const html = renderToStaticMarkup(<WorkbookQueue rows={rows} selectedKey={rows[0]?.key ?? null} onSelect={() => undefined} />);
    expect(html).toContain('Wholesale Quote Margin');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('VIOLATED');
  });

  it('dashboard renders the dispatch buttons, cron controls and import fallback', () => {
    const rows = buildQueue([patchSummary, auditSummary], [{ source: 'sample', report: workbooks }]);
    const html = renderToStaticMarkup(
      <Dashboard
        rows={rows} selected={rows[0] ?? null} audit={audit} auditAt={null} patch={patch} patchAt={null}
        cron={{ id: 'j1', name: 'suture-crew/nightly-model-audit', enabled: false, schedule: 'cron 0 2 * * *', next_run_ts: null, last_status: null, is_running: false }}
        cronBusy={false} loadError={null} importError={null} records={2}
        onSelect={() => undefined} onRefresh={() => undefined} onToggleCron={() => undefined} onRunCron={() => undefined}
        onDispatch={() => undefined} onImport={() => undefined}
      />,
    );
    for (const label of ['Schema Archaeologist', 'Invariant Adversary', 'Formula Surgeon', 'PAUSED', 'Resume', 'Run now', 'Paste or drop a Suture report']) expect(html, label).toContain(label);
  });
});
