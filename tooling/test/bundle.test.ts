// ui/dist/index.mjs: built by this repo's vite config, importing only host-provided modules (React and
// @kirocrew/app-sdk stay external), with the page as the default export React.lazy expects.
import { describe, expect, it } from 'vitest';
import { HOST_EXTERNALS } from '../vite.config.ts';
import { readText } from './helpers.ts';

const bundle = readText('ui', 'dist', 'index.mjs');

function specifiers(src: string): string[] {
  const out = new Set<string>();
  for (const m of src.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm)) out.add(m[1] ?? '');
  for (const m of src.matchAll(/^\s*export\s+[^'"]*?\s+from\s+["']([^"']+)["']/gm)) out.add(m[1] ?? '');
  for (const m of src.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.add(m[1] ?? '');
  return [...out].sort();
}

describe('ui/dist/index.mjs', () => {
  it('imports only modules the Kiro Crew dashboard provides through its import map', () => {
    const imports = specifiers(bundle);
    const allowed = new Set<string>(HOST_EXTERNALS);
    for (const s of imports) expect(allowed.has(s), s).toBe(true);
    expect(imports).toEqual(['@kirocrew/app-sdk', 'react', 'react/jsx-runtime']);
  });

  it('does not bundle React or the SDK', () => {
    for (const marker of ['__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED', 'react.production', 'react-dom.production', 'ReactCurrentDispatcher', 'scheduler.production', '__kirocrew_modules']) {
      expect(bundle.includes(marker), marker).toBe(false);
    }
    expect(bundle.length).toBeLessThan(80_000);
  });

  it('exports the page as the default export', () => {
    expect(bundle).toMatch(/export\s*\{\s*SutureCrewPage as default\s*\};?\s*$/);
  });

  it('carries the Suture tokens and the X-Ray deep-link base', () => {
    for (const token of ['#090B10', '#10141D', '#171C28', '#06B6D4', '#10B981', '#F59E0B', '#F43F5E']) expect(bundle, token).toContain(token);
    expect(bundle).toContain('https://suture-nu.vercel.app/#');
  });
});
