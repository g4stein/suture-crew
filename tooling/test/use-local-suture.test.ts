// tooling/scripts/use-local-suture.mjs on a scratch copy of the app files.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { retarget } from '../scripts/use-local-suture.mjs';
import { at } from './helpers.ts';

const dirs: string[] = [];
function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'suture-crew-retarget-'));
  dirs.push(d);
  cpSync(at('app.json'), join(d, 'app.json'));
  cpSync(at('agents'), join(d, 'agents'), { recursive: true });
  return d;
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const read = (d: string, f: string): { mcpServers: Record<string, { command: string; args: string[]; autoApprove?: string[] }> } => JSON.parse(readFileSync(join(d, f), 'utf8'));

describe('use-local-suture', () => {
  it('points the workspace and sample servers at a local SUTURE build', () => {
    const d = scratch();
    const suture = join(d, 'SUTURE');
    mkdirSync(join(suture, 'packages', 'mcp', 'dist'), { recursive: true });
    const entry = join(suture, 'packages', 'mcp', 'dist', 'suture-mcp.mjs');
    writeFileSync(entry, '');
    expect(retarget(d, { local: suture })).toEqual(['app.json', 'agents/schema-archaeologist.json', 'agents/invariant-adversary.json', 'agents/formula-surgeon.json']);
    const m = read(d, 'app.json');
    expect(m.mcpServers['suture']).toEqual({ command: 'node', args: [entry], autoApprove: ['suture_list_workbooks', 'suture_inspect_lineage'] });
    expect(m.mcpServers['ledger']?.args).toEqual(['backend/ledger_mcp.py']);
    expect(read(d, 'agents/formula-surgeon.json').mcpServers['suture-sample']).toEqual({ command: 'node', args: [entry, '--root', '{APP_ROOT}/samples'] });
  });

  it('accepts an exact alternative npm spec and refuses loose ones', () => {
    const d = scratch();
    retarget(d, { npm: '@g4stein/suture-mcp@0.1.0' });
    expect(read(d, 'app.json').mcpServers['suture']?.args).toEqual(['-y', '@g4stein/suture-mcp@0.1.0']);
    expect(() => retarget(d, { npm: '@g4stein/suture-mcp@latest' })).toThrow(/exact package spec/);
    expect(() => retarget(d, { local: 'relative/path' })).toThrow(/absolute path/);
    expect(() => retarget(d, { local: join(d, 'missing') })).toThrow(/not found/);
  });
});
