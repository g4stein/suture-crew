// app.json against the Kiro Crew manifest rules (docs/app-kit/manifest-reference.md "Validation Rules", and
// kiro_crew/apps/manifest.py AppManifest.validate). CI additionally runs the gateway's own validator
// (tooling/crew-check/crew_check.py) against a pinned KiroCrew checkout.
import { statSync } from 'node:fs';
import { isAbsolute, normalize, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { at, exists, obj, readJson, readText, REPO, strings, SUTURE_NPM } from './helpers.ts';

const m = obj(readJson('app.json'), 'app.json');

/** The containment rule: relative, no '..' segment, and canonically inside the app root. */
function contained(p: string): boolean {
  if (p === '' || isAbsolute(p) || p.split(/[\\/]/).includes('..')) return false;
  const rel = relative(REPO, resolve(REPO, normalize(p)));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

describe('app.json identity', () => {
  it('has the required non-empty identity fields', () => {
    expect(m['name']).toBe('suture-crew');
    expect(m['version']).toBe('1.0.0');
    expect(m['displayName']).toBe('Suture Crew');
    expect(m['author']).toBe('g4stein');
    expect(m['license']).toBe('MIT');
    expect(typeof m['description'] === 'string' && m['description'].length > 40).toBe(true);
    expect(strings(m['tags'], 'tags').length).toBeGreaterThan(0);
  });

  it('name is kebab-case and version is semver X.Y.Z', () => {
    expect(String(m['name'])).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(String(m['version'])).toMatch(/^\d+\.\d+\.\d+$/);
    expect(String(m['minKiroCrewVersion'])).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('has an iconPath and at most 10 highlights', () => {
    expect(m['iconPath']).toBe('assets/icon.png');
    expect(strings(m['highlights'], 'highlights').length).toBeLessThanOrEqual(10);
  });
});

describe('resource paths', () => {
  const agents = strings(m['agents'], 'agents');
  const skills = strings(m['skills'], 'skills');
  const ui = obj(m['ui'], 'ui');
  const entry = String(ui['entry']);

  it('every path is relative and stays inside the app root', () => {
    for (const p of [...agents, ...skills, entry, String(m['iconPath'])]) expect(contained(p), p).toBe(true);
  });

  it('every referenced agent, skill, icon and UI bundle exists on disk', () => {
    expect(agents).toHaveLength(3);
    for (const a of agents) expect(statSync(at(a)).isFile(), a).toBe(true);
    expect(skills).toHaveLength(2);
    for (const s of skills) expect(exists(s, 'SKILL.md'), s).toBe(true);
    expect(exists(String(m['iconPath']))).toBe(true);
    // ui.entry is validated against the app root but served from ui/ (/apps/{name}/ui/{entry}).
    expect(entry).toBe('dist/index.mjs');
    expect(exists('ui', entry)).toBe(true);
  });

  it('declares one routed page with a label, and leaves its sidebar icon to iconPath', () => {
    const pages = ui['pages'];
    expect(Array.isArray(pages) && pages.length === 1).toBe(true);
    const page = obj(Array.isArray(pages) ? pages[0] : null, 'page');
    expect(page['route']).toBe('/apps/suture-crew');
    expect(page['label']).toBe('Suture Crew');
    // A Lucide `icon` name renders only for built-in apps, and the sidebar draws an installed app's top-level iconPath
    // before any `ui.pages[].iconUrl` (manifest reference, ui.pages[].icon), so the page declares neither.
    expect(Object.keys(page).sort()).toEqual(['label', 'route']);
  });

  it('backend.hooks.routes is module.path:callable and points at a real file and function', () => {
    const hooks = obj(obj(m['backend'], 'backend')['hooks'], 'hooks');
    const spec = String(hooks['routes']);
    expect(spec).toMatch(/^[A-Za-z_][\w]*(\.[A-Za-z_]\w*)*:[A-Za-z_]\w*$/);
    const [mod, fn] = spec.split(':') as [string, string];
    const file = `${mod.replaceAll('.', '/')}.py`;
    expect(contained(file)).toBe(true);
    expect(exists(file)).toBe(true);
    expect(readText(file)).toMatch(new RegExp(`^def ${fn}\\(`, 'm'));
  });
});

describe('mcpServers', () => {
  const servers = obj(m['mcpServers'], 'mcpServers');

  it('wires the Suture MCP server pinned to an exact npm version', () => {
    const s = obj(servers['suture'], 'suture');
    expect(s['command']).toBe('npx');
    expect(strings(s['args'], 'args')).toEqual(['-y', SUTURE_NPM]);
    expect(strings(s['autoApprove'], 'autoApprove')).toEqual(['suture_list_workbooks', 'suture_inspect_lineage']);
  });

  it('wires the ledger as a bare python3 launcher with an app-relative .py (resolved under the app root by Crew)', () => {
    const l = obj(servers['ledger'], 'ledger');
    expect(l['command']).toBe('python3');
    expect(strings(l['args'], 'args')).toEqual(['backend/ledger_mcp.py']);
    expect(exists('backend/ledger_mcp.py')).toBe(true);
    expect(strings(l['autoApprove'], 'autoApprove')).toEqual(['suture_crew_record_audit']);
  });

  it('uses command/args only (no url, no secrets in env)', () => {
    for (const [name, v] of Object.entries(servers)) {
      const s = obj(v, name);
      expect(s['url'], name).toBeUndefined();
      expect(s['env'], name).toBeUndefined();
    }
  });
});

describe('crons', () => {
  const crons = m['crons'];
  it('declares nightly-model-audit, paused, with a cron expression and an app agent', () => {
    expect(Array.isArray(crons) && crons.length === 1).toBe(true);
    const c = obj(Array.isArray(crons) ? crons[0] : null, 'cron');
    expect(c['name']).toBe('nightly-model-audit');
    expect(c['enabled']).toBe(false);
    expect(c['cron_expr']).toBe('0 2 * * *');
    expect(c['every']).toBeUndefined();
    expect(c['agent']).toBe('invariant-adversary');
    expect(typeof c['message'] === 'string' && c['message'].includes('suture_crew_record_audit')).toBe(true);
  });
});

describe('permissions are minimal and honest', () => {
  const p = obj(m['permissions'], 'permissions');
  it('declares exactly the API prefixes the page calls and the capabilities it uses', () => {
    expect(strings(p['api'], 'api')).toEqual(['/api/crons', '/api/apps/suture-crew']);
    expect(p['cron']).toBe(true); // required because crons is non-empty
    expect(p['storage']).toBe(false);
    expect(p['network']).toBe(false);
    expect(Object.keys(p).sort()).toEqual(['api', 'cron', 'network', 'storage']);
  });

  it('the UI calls no API path outside permissions.api', () => {
    const src = readText('ui', 'dist', 'index.mjs');
    const paths = [...src.matchAll(/["'`](\/api\/[^"'`$]*)/g)].map((x) => x[1] ?? '');
    expect(paths.length).toBeGreaterThan(0);
    for (const path of paths) expect(path.startsWith('/api/crons') || path.startsWith('/api/apps/suture-crew'), path).toBe(true);
  });
});
