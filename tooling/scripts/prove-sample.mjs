#!/usr/bin/env node
// End-to-end proof against the real Suture MCP server: audit samples/wholesale-quote.suture.json, confirm the Exorcist
// finds the discount-stacking counterexample, verify the non-masking upstream SQL fix with suture_verify_patch, and
// record all three reports through backend/ledger_mcp.py.
//
//   SUTURE_MCP_ENTRY=/path/to/SUTURE/packages/mcp/dist/suture-mcp.mjs node tooling/scripts/prove-sample.mjs
//   node tooling/scripts/prove-sample.mjs            # uses npx -y @suture/mcp@0.1.0 (once it is published)
//   ... --write-fixtures                              # also saves the real reports to tooling/fixtures/
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMcp } from './mcp-client.mjs';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SAMPLE = 'wholesale-quote.suture.json';
export const SUTURE_NPM_SPEC = '@suture/mcp@0.1.0';

/** The non-masking fix: stack the discounts multiplicatively in the upstream SQL, so net price stays positive. */
export const SAMPLE_FIX = {
  cell: 'Pricing!A1',
  formula: '=SQL("SELECT {{Inputs!B2}}::DOUBLE * (1 - {{Inputs!B3}}::DOUBLE) * (1 - {{Inputs!B4}}::DOUBLE) * (1 - {{Inputs!B5}}::DOUBLE) AS net_price")',
};
export const SAMPLE_ASSERTIONS = ['net-price-positive', 'margin-at-most-100pct', 'margin-defined'];

/** @param {boolean} cond @param {string} message */
function check(cond, message) {
  if (!cond) throw new Error(`proof failed: ${message}`);
  console.log(`  ✓ ${message}`);
}

function sutureLauncher() {
  const entry = process.env.SUTURE_MCP_ENTRY;
  const root = join(repo, 'samples');
  if (entry !== undefined && entry !== '') return { command: process.execPath, args: [entry, '--root', root], label: entry };
  return { command: 'npx', args: ['-y', SUTURE_NPM_SPEC, '--root', root], label: `npx ${SUTURE_NPM_SPEC}` };
}

async function main() {
  const writeFixtures = process.argv.includes('--write-fixtures');
  const launcher = sutureLauncher();
  console.log(`Suture MCP: ${launcher.label}`);
  const suture = startMcp(launcher.command, launcher.args, { timeoutMs: 300_000 });
  const ledgerData = mkdtempSync(join(tmpdir(), 'suture-crew-proof-'));
  const ledger = startMcp('python3', [join(repo, 'backend', 'ledger_mcp.py')], { env: { ...process.env, SUTURE_CREW_DATA_DIR: ledgerData } });
  try {
    const init = /** @type {{ serverInfo: { name: string } }} */ (await suture.initialize());
    check(init.serverInfo.name === 'suture', 'Suture MCP server initialized');
    const tools = /** @type {{ tools: Array<{ name: string }> }} */ (await suture.request('tools/list'));
    const names = tools.tools.map((t) => t.name).sort();
    check(JSON.stringify(names) === JSON.stringify(['suture_inspect_lineage', 'suture_list_workbooks', 'suture_run_audit', 'suture_verify_patch']), 'all four Suture tools are listed');

    const workbooks = await suture.callTool('suture_list_workbooks', {});
    const files = /** @type {Array<{ path: string, error?: string, python?: string }>} */ (workbooks.files);
    const sample = files.find((f) => f.path === SAMPLE);
    check(sample !== undefined && sample.error === undefined, `${SAMPLE} is a valid Suture workbook`);
    check(sample?.python === 'none', 'the sample has no =PY() cells, so it audits without Python trust');

    const audit = await suture.callTool('suture_run_audit', { workbook: SAMPLE });
    check(audit.verdict === 'violated', `the Exorcist finds a counterexample (seed ${String(audit.seed)})`);
    const violation = /** @type {{ id: string, tier: number }} */ (audit.violation);
    check(violation.tier === 2 && SAMPLE_ASSERTIONS.includes(violation.id), `Tier 2 assertion violated: ${violation.id}`);
    const lineage = /** @type {Array<{ cell: string, dialect: string | null }>} */ (audit.lineage);
    check(lineage.some((s) => s.cell === 'Pricing!A1' && s.dialect === 'sql'), 'the failing lineage runs through the SQL pricing cell');
    const replay = /** @type {{ artifact: Record<string, unknown>, fragment: string | null }} */ (audit.replay);
    check(typeof replay.fragment === 'string' && replay.fragment.startsWith('replay=v1.'), 'a #replay=v1. X-Ray link fragment is produced');

    const patch = await suture.callTool('suture_verify_patch', { workbook: SAMPLE, patches: [SAMPLE_FIX], replayArtifact: replay.artifact });
    check(patch.counterexampleFixed === true, 'counterexampleFixed: true');
    check(patch.freshAuditPassed === true, 'freshAuditPassed: true');
    check(Array.isArray(patch.regressions) && patch.regressions.length === 0, 'regressions: 0');
    check(patch.ok === true, 'suture_verify_patch ok: true for the upstream SQL fix');

    await ledger.initialize();
    for (const [report, agent] of [[workbooks, 'schema-archaeologist'], [audit, 'invariant-adversary'], [patch, 'formula-surgeon']]) {
      const rec = await ledger.callTool('suture_crew_record_audit', { report, source: 'sample', agent });
      check(rec.recorded === true, `ledger recorded ${String(rec.kind)} report ${String(rec.id)}`);
    }
    const stored = readdirSync(join(ledgerData, 'reports')).filter((n) => n.endsWith('.json'));
    check(stored.length === 3 && stored.every((n) => !n.startsWith('.')), 'three complete records on disk, no temporary files left');
    const auditRecord = JSON.parse(readFileSync(join(ledgerData, 'reports', stored.find((n) => n.includes('-audit-')) ?? ''), 'utf8'));
    check(auditRecord.replayUrl === `https://suture-nu.vercel.app/#${replay.fragment}`, 'the audit record carries the Suture X-Ray deep link');

    if (writeFixtures) {
      const dir = join(repo, 'tooling', 'fixtures');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'workbooks.json'), `${JSON.stringify(workbooks, null, 2)}\n`);
      writeFileSync(join(dir, 'audit.json'), `${JSON.stringify(audit, null, 2)}\n`);
      writeFileSync(join(dir, 'verify-patch.json'), `${JSON.stringify(patch, null, 2)}\n`);
      console.log(`  fixtures written to ${dir}`);
    }
    console.log('Proof complete.');
  } finally {
    await suture.close();
    await ledger.close();
    rmSync(ledgerData, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
