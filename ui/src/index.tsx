/**
 * Suture Crew dashboard page. Kiro Crew imports this module with React.lazy, so the default export is the page.
 * Data: the ledger routes (backend/routes.py, under /api/apps/suture-crew) and the app's cron job (/api/crons), both
 * through the permission-scoped `useAppApi` client. Agents are dispatched with `useChatLauncher().openChat`.
 */
import { useAppApi, useChatLauncher, useNotify } from '@kirocrew/app-sdk';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Dashboard } from './components.tsx';
import {
  APP_API,
  buildQueue,
  dispatchMessage,
  findCron,
  isLedgerRecord,
  isSummaryList,
  parseReport,
  ReportError,
  type AgentName,
  type AuditReport,
  type CronJob,
  type LedgerRecord,
  type PatchReport,
  type QueueRow,
  type Report,
  type Source,
  type Summary,
  type WorkbooksReport,
} from './model.ts';
import { CSS } from './theme.ts';

const POLL_MS = 15_000;

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export default function SutureCrewPage() {
  const api = useAppApi();
  const notify = useNotify();
  const { openChat } = useChatLauncher();

  const [summaries, setSummaries] = useState<ReadonlyArray<Summary>>([]);
  const [inventories, setInventories] = useState<ReadonlyArray<{ readonly source: Source; readonly report: WorkbooksReport }>>([]);
  const [cron, setCron] = useState<CronJob | null>(null);
  const [cronBusy, setCronBusy] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [records, setRecords] = useState<Readonly<Record<string, LedgerRecord>>>({});
  const [imported, setImported] = useState<{ readonly audit: AuditReport | null; readonly patch: PatchReport | null }>({ audit: null, patch: null });
  const [loadError, setLoadError] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  const fetchRecord = useCallback(async (id: string): Promise<LedgerRecord | null> => {
    const r = await api.get<unknown>(`${APP_API}/reports/${encodeURIComponent(id)}`);
    return isLedgerRecord(r) ? r : null;
  }, [api]);

  const load = useCallback(async () => {
    try {
      const [list, crons] = await Promise.all([api.get<unknown>(`${APP_API}/reports`), api.get<unknown>('/api/crons')]);
      if (!isSummaryList(list)) throw new Error('the ledger answered with an unexpected shape');
      setSummaries(list.records);
      setCron(findCron(crons));
      // The newest inventory per source names the workbooks the queue monitors.
      const latest = new Map<Source, Summary>();
      for (const s of list.records) if (s.kind === 'workbooks' && !latest.has(s.source)) latest.set(s.source, s);
      const inv: Array<{ source: Source; report: WorkbooksReport }> = [];
      for (const [source, s] of latest) {
        const rec = await fetchRecord(s.id);
        if (rec !== null && rec.report.format === 'suture.workbooks') inv.push({ source, report: rec.report });
      }
      setInventories(inv);
      setLoadError(null);
    } catch (e) {
      setLoadError(`Could not load the ledger: ${message(e)}`);
    }
  }, [api, fetchRecord]);

  useEffect(() => {
    void load();
    const t = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const rows = useMemo(() => buildQueue(summaries, inventories), [summaries, inventories]);
  const selected: QueueRow | null = rows.find((r) => r.key === selectedKey) ?? rows[0] ?? null;

  // Fetch the full audit and patch records for the selected workbook.
  useEffect(() => {
    const ids = [selected?.lastAudit?.id, selected?.lastPatch?.id].filter((id): id is string => id !== undefined && records[id] === undefined);
    if (ids.length === 0) return;
    let live = true;
    void Promise.all(ids.map(fetchRecord)).then((got) => {
      if (!live) return;
      setRecords((prev) => {
        const next: Record<string, LedgerRecord> = { ...prev };
        for (const r of got) if (r !== null) next[r.id] = r;
        return next;
      });
    }).catch((e: unknown) => { if (live) setLoadError(`Could not load a report: ${message(e)}`); });
    return () => { live = false; };
  }, [selected?.lastAudit?.id, selected?.lastPatch?.id, records, fetchRecord]);

  const auditRec = selected?.lastAudit ? records[selected.lastAudit.id] : undefined;
  const patchRec = selected?.lastPatch ? records[selected.lastPatch.id] : undefined;
  const audit: AuditReport | null = imported.audit ?? (auditRec?.report.format === 'suture.audit' ? auditRec.report : null);
  const patch: PatchReport | null = imported.patch ?? (patchRec?.report.format === 'suture.verify-patch' ? patchRec.report : null);

  const toggleCron = useCallback(async (enabled: boolean) => {
    if (cron === null) return;
    setCronBusy(true);
    try {
      await api.post(`/api/crons/${encodeURIComponent(cron.id)}/enable`, { enabled });
      notify(enabled ? 'nightly-model-audit resumed' : 'nightly-model-audit paused', { type: 'success' });
      await load();
    } catch (e) {
      notify(`Could not update the schedule: ${message(e)}`, { type: 'error' });
    } finally {
      setCronBusy(false);
    }
  }, [api, cron, load, notify]);

  const runCron = useCallback(async () => {
    if (cron === null) return;
    setCronBusy(true);
    try {
      await api.post(`/api/crons/${encodeURIComponent(cron.id)}/run`);
      notify('nightly-model-audit started', { type: 'success' });
      await load();
    } catch (e) {
      notify(`Could not start the audit: ${message(e)}`, { type: 'error' });
    } finally {
      setCronBusy(false);
    }
  }, [api, cron, load, notify]);

  const dispatch = useCallback((agent: AgentName) => {
    openChat({ agent, message: dispatchMessage(agent, selected) });
  }, [openChat, selected]);

  const importReport = useCallback((text: string) => {
    try {
      const report: Report = parseReport(JSON.parse(text));
      if (report.format === 'suture.audit') setImported((p) => ({ ...p, audit: report }));
      else if (report.format === 'suture.verify-patch') setImported((p) => ({ ...p, patch: report }));
      else setInventories((prev) => [...prev.filter((i) => i.source !== 'imported'), { source: 'imported', report }]);
      setImportError(null);
    } catch (e) {
      setImportError(e instanceof ReportError || e instanceof SyntaxError ? e.message : message(e));
    }
  }, []);

  const select = useCallback((row: QueueRow) => {
    setSelectedKey(row.key);
    setImported({ audit: null, patch: null });
  }, []);

  return (
    <>
      <style>{CSS}</style>
      <Dashboard
        rows={rows}
        selected={selected}
        audit={audit}
        auditAt={imported.audit !== null ? 'imported' : auditRec?.recordedAt ?? null}
        patch={patch}
        patchAt={imported.patch !== null ? 'imported' : patchRec?.recordedAt ?? null}
        cron={cron}
        cronBusy={cronBusy}
        loadError={loadError}
        importError={importError}
        records={summaries.length}
        onSelect={select}
        onRefresh={() => { void load(); }}
        onToggleCron={(enabled) => { void toggleCron(enabled); }}
        onRunCron={() => { void runCron(); }}
        onDispatch={dispatch}
        onImport={importReport}
      />
    </>
  );
}
