// agents/*.json and skills/*/SKILL.md: they parse, and every tool or skill they name exists.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { at, obj, readJson, readText, strings, SUTURE_NPM, SUTURE_TOOLS } from './helpers.ts';

const manifest = obj(readJson('app.json'), 'app.json');
const agentPaths = strings(manifest['agents'], 'agents');
const skillPaths = strings(manifest['skills'], 'skills');
const APP = String(manifest['name']);
const BUILTIN_TOOLS = new Set(['fs_read', 'fs_write', 'grep', 'glob']);
const HOST_PLACEHOLDERS = new Set(['{APP_ROOT}', '{APP_DATA}', '{UV_BIN}', '{HOST_PATH}', '{PATH_SEP}']);

/** The ledger's tool names, asked of the real server over stdio. */
function ledgerTools(): string[] {
  const input = `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`;
  const r = spawnSync('python3', [at('backend', 'ledger_mcp.py')], { input, encoding: 'utf8', env: { ...process.env, SUTURE_CREW_DATA_DIR: at('tooling', '.unused-ledger') } });
  expect(r.status).toBe(0);
  const reply = obj(JSON.parse(r.stdout.trim()), 'reply');
  const tools = obj(reply['result'], 'result')['tools'];
  if (!Array.isArray(tools)) throw new Error('no tools');
  return tools.map((t) => String(obj(t, 'tool')['name']));
}

const LEDGER_TOOLS = ledgerTools();

/** Every tool a reference may name: "@server/tool" for each MCP server an agent can reach. */
function knownRefs(agentServers: ReadonlyArray<string>): Set<string> {
  const refs = new Set<string>(BUILTIN_TOOLS);
  for (const t of SUTURE_TOOLS) refs.add(`@${APP}:suture/${t}`);
  for (const t of LEDGER_TOOLS) refs.add(`@${APP}:ledger/${t}`);
  for (const s of agentServers) if (s === 'suture-sample') for (const t of SUTURE_TOOLS) refs.add(`@suture-sample/${t}`);
  return refs;
}

describe('the ledger server', () => {
  it('serves exactly suture_crew_record_audit', () => {
    expect(LEDGER_TOOLS).toEqual(['suture_crew_record_audit']);
  });
});

describe.each(agentPaths)('%s', (path) => {
  const agent = obj(readJson(path), path);
  const name = String(agent['name']);
  const tools = strings(agent['tools'], 'tools');
  const allowed = strings(agent['allowedTools'], 'allowedTools');
  const servers = obj(agent['mcpServers'], 'mcpServers');
  const prompt = String(agent['prompt']);

  it('has the kiro-cli agent fields and a name matching its file', () => {
    expect(path).toBe(`agents/${name}.json`);
    expect(name).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(String(agent['description']).length).toBeGreaterThan(40);
    expect(prompt.length).toBeGreaterThan(400);
    expect(agent['includeMcpJson']).toBe(false);
  });

  it('every tool reference resolves to a real tool on a reachable server', () => {
    const known = knownRefs(Object.keys(servers));
    for (const t of tools) expect(known.has(t), t).toBe(true);
    expect(new Set(tools).size).toBe(tools.length);
  });

  it('auto-approves only a subset of its tools, and never a workspace audit or a file write', () => {
    for (const t of allowed) expect(tools, t).toContain(t);
    // Kiro Crew strips built-in tools from an app agent's allowedTools at registration (verified by crew-check), so
    // only MCP tool references belong here.
    for (const t of allowed) expect(t.startsWith('@'), t).toBe(true);
    expect(allowed).not.toContain('fs_write');
    expect(allowed).not.toContain(`@${APP}:suture/suture_run_audit`);
    expect(allowed).not.toContain(`@${APP}:suture/suture_verify_patch`);
  });

  it('records reports through the ledger', () => {
    expect(tools).toContain(`@${APP}:ledger/suture_crew_record_audit`);
    expect(prompt).toContain('suture_crew_record_audit');
  });

  it('declares the bundled-sample server with only known host placeholders', () => {
    const s = obj(servers['suture-sample'], 'suture-sample');
    expect(s['command']).toBe('npx');
    expect(strings(s['args'], 'args')).toEqual(['-y', SUTURE_NPM, '--root', '{APP_ROOT}/samples']);
    const placeholders = JSON.stringify(agent).match(/\{[A-Z_]+\}/g) ?? [];
    for (const p of placeholders) expect(HOST_PLACEHOLDERS.has(p), p).toBe(true);
  });

  it('names only skills the app ships', () => {
    const shipped = new Set(skillPaths.map((p) => p.split('/').pop() ?? ''));
    for (const m of prompt.matchAll(/\b(suture-[a-z-]+) skill/g)) expect(shipped.has(m[1] ?? ''), m[1]).toBe(true);
  });
});

describe.each(skillPaths)('%s/SKILL.md', (path) => {
  const text = readText(path, 'SKILL.md');
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);

  it('has YAML frontmatter with name, description, always and triggers', () => {
    expect(fm).not.toBeNull();
    const fields = new Map((fm?.[1] ?? '').split('\n').map((l) => [l.slice(0, l.indexOf(':')), l.slice(l.indexOf(':') + 1).trim()] as const));
    expect(fields.get('name')).toBe(path.split('/').pop());
    expect((fields.get('description') ?? '').length).toBeGreaterThan(60);
    expect(fields.get('always')).toBe('false');
    expect((fields.get('triggers') ?? '').length).toBeGreaterThan(0);
  });

  it('mentions only real Suture tool names', () => {
    for (const m of text.matchAll(/\bsuture_[a-z_]+\b/g)) {
      const known = new Set<string>([...SUTURE_TOOLS, ...LEDGER_TOOLS]);
      expect(known.has(m[0]), m[0]).toBe(true);
    }
  });

  it('is the only file in its directory', () => {
    expect(readdirSync(at(path))).toEqual(['SKILL.md']);
  });
});
