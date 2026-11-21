/**
 * Data model for the Suture Crew page: the ledger's record shapes (backend/ledger_mcp.py), the Suture report fields the
 * panes render (Suture packages/runtime/src/headless), and the pure functions that derive what the page shows.
 * Everything arriving from the network or a pasted file is `unknown` until a guard below accepts it.
 */

export const APP_API = '/api/apps/suture-crew';
export const CRON_NAME = 'suture-crew/nightly-model-audit';
export const XRAY_BASE = 'https://suture-nu.vercel.app/#';
export const MAX_FRAGMENT_CHARS = 8192;

export type AgentName = 'schema-archaeologist' | 'invariant-adversary' | 'formula-surgeon';
export type RecordKind = 'workbooks' | 'audit' | 'patch';
export type Source = 'workspace' | 'sample' | 'imported';
export type Dialect = 'literal' | 'formula' | 'sql' | 'py';
export type Verdict = 'passed' | 'violated' | 'configError' | 'stopped';

/** A cell value as Suture's headless JSON encodes it. */
export type JsonCell =
  | number
  | string
  | boolean
  | null
  | { readonly error: string; readonly message: string; readonly origin: string; readonly engine: string }
  | { readonly table: { readonly rows: number; readonly columns: ReadonlyArray<string> } }
  | { readonly matrix: { readonly rows: number; readonly cols: number } }
  | { readonly pending: true };

export interface WorkbookInfo {
  readonly ref: string;
  readonly title: string;
  readonly hash: string;
  readonly python: string;
}

export interface Violation {
  readonly tier: 1 | 2;
  readonly id: string;
  readonly cell: string | null;
  readonly rule: string;
  readonly detail: string;
}

export interface LineageStep {
  readonly cell: string;
  readonly dialect: Dialect | null;
  readonly value: JsonCell;
  readonly base: JsonCell;
}

export interface AuditReport {
  readonly format: 'suture.audit';
  readonly workbook: WorkbookInfo;
  readonly seed: number;
  readonly verdict: Verdict;
  readonly message: string | null;
  readonly search: { readonly runs: number };
  readonly tier1: ReadonlyArray<{ readonly id: string; readonly label: string; readonly status: string }>;
  readonly tier2: ReadonlyArray<{ readonly id: string; readonly cell: string; readonly rule: string; readonly status: string }>;
  readonly violation: Violation | null;
  readonly failingInputs: ReadonlyArray<{ readonly cell: string; readonly value: JsonCell }>;
  readonly lineage: ReadonlyArray<LineageStep>;
  readonly failingEdge: { readonly from: string; readonly to: string } | null;
  readonly replay: { readonly artifact: Readonly<Record<string, unknown>>; readonly fragment: string | null } | null;
}

export interface Regression {
  readonly kind: 'assertion' | 'newError';
  readonly cell: string;
  readonly id?: string;
  readonly rule?: string;
  readonly detail?: string;
  readonly code?: string;
  readonly message?: string;
}

export interface PatchReport {
  readonly format: 'suture.verify-patch';
  readonly ok: boolean;
  readonly seed: number;
  readonly workbook: WorkbookInfo;
  readonly patches: ReadonlyArray<{ readonly cell: string; readonly before: string | null; readonly after: string }>;
  readonly patchErrors: ReadonlyArray<string>;
  readonly counterexampleFixed: boolean | null;
  readonly freshAuditPassed: boolean;
  readonly regressions: ReadonlyArray<Regression>;
  readonly baseValueDiffs: ReadonlyArray<{ readonly cell: string; readonly before: JsonCell; readonly after: JsonCell }>;
}

export interface WorkbooksReport {
  readonly format: 'suture.workbooks';
  readonly root: string;
  readonly flagships: ReadonlyArray<{ readonly id: string; readonly title: string; readonly hash: string }>;
  readonly files: ReadonlyArray<{ readonly path: string; readonly title?: string; readonly hash?: string; readonly python?: string; readonly error?: string }>;
}

export type Report = AuditReport | PatchReport | WorkbooksReport;

export interface Summary {
  readonly id: string;
  readonly kind: RecordKind;
  readonly recordedAt: string;
  readonly source: Source;
  readonly agent: AgentName | null;
  readonly workbook: { readonly ref: string; readonly title: string; readonly hash: string } | null;
  readonly status: string;
  readonly detail: string | null;
  readonly replayUrl: string | null;
}

export interface LedgerRecord {
  readonly id: string;
  readonly kind: RecordKind;
  readonly recordedAt: string;
  readonly source: Source;
  readonly agent: AgentName | null;
  readonly replayUrl: string | null;
  readonly report: Report;
}

export interface CronJob {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly schedule: string;
  readonly next_run_ts: number | null;
  readonly last_status: string | null;
  readonly is_running: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------------------------------

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isArr = (v: unknown): v is ReadonlyArray<unknown> => Array.isArray(v);

export class ReportError extends Error {}

function need(cond: boolean, path: string, message: string): asserts cond {
  if (!cond) throw new ReportError(`${path} ${message}`);
}

function isWorkbookInfo(v: unknown): v is WorkbookInfo {
  return isObj(v) && isStr(v['ref']) && isStr(v['title']) && isStr(v['hash']) && isStr(v['python']);
}

/** Accepts a Suture tool result (the same three formats the ledger accepts) or throws a ReportError naming the field. */
export function parseReport(value: unknown): Report {
  need(isObj(value), '$', 'must be a JSON object');
  need(value['version'] === 1, '$.version', 'must be 1');
  const format = value['format'];
  if (format === 'suture.audit') {
    need(isWorkbookInfo(value['workbook']), '$.workbook', 'must be { ref, title, hash, python }');
    need(['passed', 'violated', 'configError', 'stopped'].includes(String(value['verdict'])), '$.verdict', 'is not a Suture verdict');
    need(isNum(value['seed']), '$.seed', 'must be a number');
    for (const k of ['tier1', 'tier2', 'failingInputs', 'lineage'] as const) need(isArr(value[k]), `$.${k}`, 'must be an array');
    const lineage = value['lineage'] as ReadonlyArray<unknown>;
    lineage.forEach((s, i) => need(isObj(s) && isStr(s['cell']), `$.lineage[${i}]`, 'must be { cell, dialect, value, base }'));
    const replay = value['replay'];
    need(replay === null || (isObj(replay) && isObj(replay['artifact'])), '$.replay', 'must be { artifact, fragment } or null');
    return value as unknown as AuditReport;
  }
  if (format === 'suture.verify-patch') {
    need(isWorkbookInfo(value['workbook']), '$.workbook', 'must be { ref, title, hash, python }');
    need(typeof value['ok'] === 'boolean', '$.ok', 'must be a boolean');
    need(typeof value['freshAuditPassed'] === 'boolean', '$.freshAuditPassed', 'must be a boolean');
    for (const k of ['patches', 'regressions', 'baseValueDiffs', 'patchErrors'] as const) need(isArr(value[k]), `$.${k}`, 'must be an array');
    return value as unknown as PatchReport;
  }
  if (format === 'suture.workbooks') {
    need(isStr(value['root']), '$.root', 'must be a string');
    need(isArr(value['flagships']) && isArr(value['files']), '$.files', 'must be an array');
    return value as unknown as WorkbooksReport;
  }
  throw new ReportError("$.format must be 'suture.workbooks', 'suture.audit' or 'suture.verify-patch'");
}

export function kindOf(report: Report): RecordKind {
  return report.format === 'suture.audit' ? 'audit' : report.format === 'suture.verify-patch' ? 'patch' : 'workbooks';
}

export function isSummaryList(v: unknown): v is { readonly records: ReadonlyArray<Summary> } {
  return isObj(v) && isArr(v['records']) && v['records'].every((r) => isObj(r) && isStr(r['id']) && isStr(r['kind']) && isStr(r['status']));
}

export function isLedgerRecord(v: unknown): v is LedgerRecord {
  if (!isObj(v) || !isStr(v['id']) || !isStr(v['kind'])) return false;
  try {
    parseReport(v['report']);
    return true;
  } catch {
    return false;
  }
}

export function findCron(v: unknown): CronJob | null {
  if (!isObj(v) || !isArr(v['jobs'])) return null;
  const job = v['jobs'].find((j) => isObj(j) && j['name'] === CRON_NAME);
  if (!isObj(job) || !isStr(job['id']) || typeof job['enabled'] !== 'boolean') return null;
  return {
    id: job['id'],
    name: CRON_NAME,
    enabled: job['enabled'],
    schedule: isStr(job['schedule']) ? job['schedule'] : '',
    next_run_ts: isNum(job['next_run_ts']) ? job['next_run_ts'] : null,
    last_status: isStr(job['last_status']) ? job['last_status'] : null,
    is_running: job['is_running'] === true,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Derivations
// ---------------------------------------------------------------------------------------------------------------------

/** The X-Ray deep link for a replay fragment, or null when there is none or it would not fit in a URL. */
export function replayUrl(fragment: string | null | undefined): string | null {
  if (fragment === null || fragment === undefined) return null;
  if (!/^replay=v1\.[A-Za-z0-9_-]+$/.test(fragment) || fragment.length + 1 > MAX_FRAGMENT_CHARS) return null;
  return XRAY_BASE + fragment;
}

export const DIALECT_LABEL: Readonly<Record<Dialect, string>> = { literal: 'IN', sql: 'SQL', py: 'PY', formula: 'FX' };

export function dialectLabel(d: Dialect | null): string {
  return d === null ? '—' : DIALECT_LABEL[d];
}

/** The dialect sequence of a failing lineage with consecutive repeats collapsed: e.g. "IN → SQL → FX". */
export function lineageChain(lineage: ReadonlyArray<LineageStep>): string {
  const out: string[] = [];
  for (const step of lineage) {
    const label = dialectLabel(step.dialect);
    if (out[out.length - 1] !== label) out.push(label);
  }
  return out.join(' → ');
}

export function formatCell(v: JsonCell): string {
  if (v === null) return 'null';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(10)));
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if ('error' in v) return v.error;
  if ('table' in v) return `table ${v.table.rows}×${v.table.columns.length}`;
  if ('matrix' in v) return `matrix ${v.matrix.rows}×${v.matrix.cols}`;
  return 'pending';
}

export type WorkbookStatus = 'violated' | 'passed' | 'configError' | 'stopped' | 'unaudited';

export interface QueueRow {
  readonly key: string;
  readonly ref: string;
  readonly title: string;
  readonly source: Source;
  readonly status: WorkbookStatus;
  readonly lastAudit: Summary | null;
  readonly lastPatch: Summary | null;
}

/**
 * The monitored-workbooks queue: every workbook seen in an inventory or an audit, newest evidence first, with its latest
 * audit verdict. `summaries` arrive newest first; `inventories` are full workbooks reports keyed by source.
 */
export function buildQueue(summaries: ReadonlyArray<Summary>, inventories: ReadonlyArray<{ readonly source: Source; readonly report: WorkbooksReport }>): QueueRow[] {
  const rows = new Map<string, { ref: string; title: string; source: Source; lastAudit: Summary | null; lastPatch: Summary | null }>();
  const touch = (source: Source, ref: string, title: string) => {
    const key = `${source}:${ref}`;
    const row = rows.get(key) ?? { ref, title, source, lastAudit: null, lastPatch: null };
    rows.set(key, row);
    return row;
  };
  for (const inv of inventories) {
    for (const f of inv.report.files) if (f.error === undefined) touch(inv.source, f.path, f.title ?? f.path);
  }
  for (const s of summaries) {
    if (s.workbook === null) continue;
    const row = touch(s.source, s.workbook.ref, s.workbook.title);
    if (s.kind === 'audit' && row.lastAudit === null) row.lastAudit = s;
    if (s.kind === 'patch' && row.lastPatch === null) row.lastPatch = s;
  }
  const order: Readonly<Record<WorkbookStatus, number>> = { violated: 0, configError: 1, stopped: 2, unaudited: 3, passed: 4 };
  return [...rows.entries()]
    .map(([key, r]) => {
      const st = r.lastAudit?.status;
      const status: WorkbookStatus = st === 'violated' || st === 'passed' || st === 'configError' || st === 'stopped' ? st : 'unaudited';
      return { key, ref: r.ref, title: r.title, source: r.source, status, lastAudit: r.lastAudit, lastPatch: r.lastPatch };
    })
    .sort((a, b) => order[a.status] - order[b.status] || a.ref.localeCompare(b.ref));
}

export interface PatchChecks {
  readonly counterexampleFixed: boolean | null;
  readonly freshAuditPassed: boolean;
  readonly regressions: number;
  readonly ok: boolean;
}

export function patchChecks(p: PatchReport): PatchChecks {
  return { counterexampleFixed: p.counterexampleFixed, freshAuditPassed: p.freshAuditPassed, regressions: p.regressions.length, ok: p.ok };
}

/** The chat message each quick-dispatch button sends. */
export function dispatchMessage(agent: AgentName, row: QueueRow | null): string {
  const target = row === null ? 'the workspace (or the bundled sample if the workspace has no .suture.json files)' : `${row.ref} on the ${row.source === 'sample' ? '@suture-sample' : '@suture-crew:suture'} server`;
  switch (agent) {
    case 'schema-archaeologist':
      return `Map ${target}: sheets, fuzz inputs, assertions, and the SQL → PY → FX lineage of every asserted cell. Record the inventory in the ledger.`;
    case 'invariant-adversary':
      return `Run the Exorcist audit on ${target}, record every report in the ledger, and give me the Suture X-Ray link for any counterexample.`;
    case 'formula-surgeon':
      return `Take the latest counterexample for ${target}, find the upstream cause, and prove a non-masking fix with suture_verify_patch (0 regressions) before showing me the diff.`;
  }
}

export function formatTime(ts: number | null): string {
  if (ts === null) return '—';
  const d = new Date(ts * 1000);
  return Number.isNaN(d.getTime()) ? '—' : d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
}
