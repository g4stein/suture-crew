// Repository hygiene: license, .kiro/ tracked, Kiro hooks valid, trademark scan, dependency licenses, and no
// placeholder or `any` in the sources.
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { audit, parseSpdx, verdict } from '../scripts/license-audit.mjs';
import { loadDigests, repoFiles, scanRepo, scanText, sha256 } from '../scripts/trademark-scan.mjs';
import { exists, obj, readJson, readText, REPO } from './helpers.ts';

const git = (...args: string[]): string => execFileSync('git', args, { cwd: REPO, encoding: 'utf8' });

describe('license', () => {
  it('LICENSE is the standard MIT text', () => {
    const text = readText('LICENSE');
    expect(text.startsWith('MIT License')).toBe(true);
    expect(text).toContain('Permission is hereby granted, free of charge');
    expect(text).toContain('THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND');
  });
});

describe('.kiro/ is part of the repository', () => {
  it('.gitignore never ignores .kiro/', () => {
    const ignore = readText('.gitignore');
    expect(ignore.split('\n').some((l) => /^\s*!?\/?\.kiro\b/.test(l))).toBe(false);
    for (const p of ['.kiro/steering/suture-crew-architecture.md', '.kiro/specs/01-suture-crew-app/tasks.md', '.kiro/hooks/crew-app-guard.json']) {
      let ignored = true;
      try { git('check-ignore', '-q', p); } catch { ignored = false; }
      expect(ignored, p).toBe(false);
    }
  });

  it('has steering, the spec, and at least one hook', () => {
    expect(exists('.kiro', 'steering', 'suture-crew-architecture.md')).toBe(true);
    for (const f of ['requirements.md', 'design.md', 'tasks.md']) expect(exists('.kiro', 'specs', '01-suture-crew-app', f), f).toBe(true);
    expect(readdirSync(`${REPO}/.kiro/hooks`).filter((f) => f.endsWith('.json')).length).toBeGreaterThan(0);
  });

  it('every hook file follows the .kiro/hooks v1 schema and runs a real script', () => {
    const triggers = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'SessionStart', 'Stop', 'SubagentStop', 'UserPromptSubmit', 'PreTaskExec', 'PostTaskExec', 'PreCompact', 'PostCompact', 'PostFileCreate', 'PostFileSave', 'PostFileDelete']);
    const scripts = obj(obj(readJson('tooling', 'package.json'), 'package.json')['scripts'], 'scripts');
    for (const f of readdirSync(`${REPO}/.kiro/hooks`).filter((x) => x.endsWith('.json'))) {
      const file = obj(readJson('.kiro', 'hooks', f), f);
      expect(file['version']).toBe('v1');
      const hooks = file['hooks'];
      expect(Array.isArray(hooks) && hooks.length > 0).toBe(true);
      for (const h of Array.isArray(hooks) ? hooks : []) {
        const hook = obj(h, 'hook');
        expect(typeof hook['name']).toBe('string');
        expect(triggers.has(String(hook['trigger'])), String(hook['trigger'])).toBe(true);
        if (hook['matcher'] !== undefined) expect(() => new RegExp(String(hook['matcher']))).not.toThrow();
        const action = obj(hook['action'], 'action');
        expect(action['type']).toBe('command');
        const m = /pnpm -C tooling (?:run )?([a-z:]+)/.exec(String(action['command']));
        expect(m, String(action['command'])).not.toBeNull();
        expect(scripts[m?.[1] ?? ''], m?.[1]).toBeDefined();
      }
    }
  });
});

describe('trademark hygiene', () => {
  it('the scanner detects a listed digest without the term being written anywhere', () => {
    const digests = new Set([sha256('zzqxv'), sha256('alpha omega')]);
    expect(scanText('plain text with zzqxv inside', digests)).toEqual([{ line: 1, column: 17, digest: sha256('zzqxv') }]);
    expect(scanText('see alphaOmega', digests)).toHaveLength(1);
    expect(loadDigests().size).toBeGreaterThan(0);
  });

  it('no file a commit could contain names a third-party spreadsheet product', () => {
    expect(repoFiles().length).toBeGreaterThan(30);
    expect(scanRepo()).toEqual([]);
  });
});

describe('source hygiene', () => {
  const sources = repoFiles().filter((f) => /\.(ts|tsx|mjs|py|json|md|yml)$/.test(f) && !f.startsWith('ui/dist/') && !f.startsWith('tooling/fixtures/') && f !== 'tooling/pnpm-lock.yaml');

  it('has no placeholder markers', () => {
    const marker = new RegExp(['TO', 'DO'].join('') + '|' + ['FIX', 'ME'].join('') + '|' + ['X', 'XX'].join('') + '\\b');
    for (const f of sources) expect(marker.test(readText(f)), f).toBe(false);
  });

  it('TypeScript sources never use the any type', () => {
    const t = ['a', 'ny'].join('');
    const anyType = new RegExp(`(:\\s*${t}\\b|\\bas\\s+${t}\\b|<${t}>|\\b${t}\\[\\])`);
    for (const f of sources.filter((x) => /\.(ts|tsx)$/.test(x))) expect(anyType.test(readText(f)), f).toBe(false);
  });
});

describe('dependency licenses', () => {
  it('the SPDX policy accepts permissive alternatives and refuses copyleft and undeclared licenses', () => {
    expect(parseSpdx('(MIT OR GPL-3.0-or-later)')).toEqual([['MIT'], ['GPL-3.0']]);
    expect(verdict('(MIT OR GPL-3.0-or-later)').ok).toBe(true);
    for (const bad of ['GPL-3.0-only', 'LGPL-2.1+', 'AGPL-3.0', 'MIT AND GPL-2.0', 'MPL-2.0', '(MIT']) expect(verdict(bad).ok, bad).toBe(false);
    expect(verdict(null).ok).toBe(false);
  });

  it('every installed tooling package passes', () => {
    const r = audit();
    expect(r.checked).toBeGreaterThan(20);
    expect(r.failures).toEqual([]);
  });

  it('the app ships no npm or pip manifest at its root, so a registry install runs no build', () => {
    for (const f of ['package.json', 'requirements.txt', 'pyproject.toml', 'setup.py']) expect(exists(f), f).toBe(false);
  });
});
