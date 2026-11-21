#!/usr/bin/env node
// Dependency license audit for tooling/ (policy: .kiro/steering/suture-crew-architecture.md, "License policy").
// Source of truth: every package in tooling/pnpm-lock.yaml. Each installed package's declared license is parsed as an
// SPDX expression (AND / OR / WITH / parentheses / "-or-later" / "+"). A package passes when at least one
// OR-alternative is fully permissive. GPL / LGPL / AGPL never satisfy the policy; MPL and other weak-copyleft licenses
// are not on the allowlist either. A missing or unparseable license fails.
// Adapted from g4stein/SUTURE scripts/license-check.mjs (MIT).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tooling = join(dirname(fileURLToPath(import.meta.url)), '..');

export const PERMISSIVE = new Set([
  'MIT', 'MIT-0', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', '0BSD', 'CC0-1.0', 'BlueOak-1.0.0', 'Unlicense',
  'Python-2.0', 'PSF-2.0', 'CC-BY-4.0', 'Zlib',
]);
const ALIASES = new Map([['MIT/X11', 'MIT'], ['X11', 'MIT'], ['Apache 2.0', 'Apache-2.0'], ['BSD', 'BSD-3-Clause']]);
const COPYLEFT = /^(A|L)?GPL-|^GPL$|^LGPL$|^AGPL$/i;

/** Parses an SPDX expression into an OR-of-ANDs list of license identifiers. @param {string} expr @returns {string[][]} */
export function parseSpdx(expr) {
  const src = ALIASES.get(expr.trim()) ?? expr;
  const toks = src.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => toks[i];
  const next = () => toks[i++];
  /** @returns {string[][]} */
  function primary() {
    const t = next();
    if (t === undefined) throw new Error(`unexpected end of "${expr}"`);
    if (t === '(') {
      const v = orExpr();
      if (next() !== ')') throw new Error(`unbalanced parentheses in "${expr}"`);
      return v;
    }
    if (/^(AND|OR|WITH)$/i.test(t) || t === ')') throw new Error(`unexpected "${t}" in "${expr}"`);
    const id = (ALIASES.get(t) ?? t).replace(/\+$/, '').replace(/-or-later$|-only$/, '');
    if (peek()?.toUpperCase() === 'WITH') { next(); next(); }
    return [[id]];
  }
  function andExpr() {
    let left = primary();
    while (peek()?.toUpperCase() === 'AND') {
      next();
      const right = primary();
      left = left.flatMap((a) => right.map((b) => [...a, ...b]));
    }
    return left;
  }
  function orExpr() {
    let left = andExpr();
    while (peek()?.toUpperCase() === 'OR') {
      next();
      left = [...left, ...andExpr()];
    }
    return left;
  }
  const out = orExpr();
  if (i !== toks.length) throw new Error(`trailing tokens in "${expr}"`);
  return out;
}

/** @param {string | null} license @returns {{ ok: boolean, reason: string }} */
export function verdict(license) {
  if (license === null) return { ok: false, reason: 'no license declared' };
  let alternatives;
  try {
    alternatives = parseSpdx(license);
  } catch (e) {
    return { ok: false, reason: `unparseable license expression: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (alternatives.some((all) => all.every((id) => PERMISSIVE.has(id)))) return { ok: true, reason: '' };
  if (alternatives.flat().some((id) => COPYLEFT.test(id))) return { ok: false, reason: `forbidden copyleft license ${license}` };
  return { ok: false, reason: `license ${license} is not on the allowlist` };
}

/** Every `name@version` in a pnpm lockfile's packages: sections. @param {string} text */
export function packagesFromLock(text) {
  /** @type {Map<string, { name: string, version: string }>} */
  const out = new Map();
  const sections = text.split(/\n(?=\S)/).filter((s) => s.startsWith('packages:'));
  if (sections.length === 0) throw new Error('pnpm-lock.yaml has no packages: section');
  for (const section of sections) {
    for (const line of section.split('\n')) {
      const m = /^ {2}'?(@?[^@'\s]+(?:\/[^@'\s]+)?)@([^:'(\s]+)[^:]*'?:\s*$/.exec(line);
      if (m && m[1] !== undefined && m[2] !== undefined) out.set(`${m[1]}@${m[2]}`, { name: m[1], version: m[2] });
    }
  }
  return [...out.values()];
}

/** @param {{ name: string, version: string }} pkg */
function licenseOf(pkg) {
  const file = join(tooling, 'node_modules', '.pnpm', `${pkg.name.replace('/', '+')}@${pkg.version}`, 'node_modules', pkg.name, 'package.json');
  if (!existsSync(file)) return { license: null, installed: false };
  const json = JSON.parse(readFileSync(file, 'utf8'));
  let lic = json.license ?? json.licenses;
  if (Array.isArray(lic)) lic = `(${lic.map((l) => (typeof l === 'string' ? l : l.type)).join(' OR ')})`;
  else if (lic && typeof lic === 'object') lic = lic.type;
  return { license: typeof lic === 'string' ? lic : null, installed: true };
}

/** Audits tooling/pnpm-lock.yaml. @returns {{ checked: number, skipped: number, failures: string[], tally: Map<string, number> }} */
export function audit() {
  const pkgs = packagesFromLock(readFileSync(join(tooling, 'pnpm-lock.yaml'), 'utf8'));
  /** @type {Map<string, number>} */
  const tally = new Map();
  /** @type {string[]} */
  const failures = [];
  let skipped = 0;
  for (const p of pkgs) {
    const { license, installed } = licenseOf(p);
    if (!installed) { skipped++; continue; }
    tally.set(license ?? 'UNKNOWN', (tally.get(license ?? 'UNKNOWN') ?? 0) + 1);
    const v = verdict(license);
    if (!v.ok) failures.push(`${p.name}@${p.version}: ${v.reason}`);
  }
  return { checked: pkgs.length - skipped, skipped, failures, tally };
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const r = audit();
  console.log(`license audit: ${r.checked} installed packages checked (${r.skipped} optional other-platform binaries not installed here)`);
  for (const [lic, n] of [...r.tally].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${lic}`);
  if (r.failures.length > 0) {
    console.error(`FAIL:\n  ${r.failures.join('\n  ')}`);
    process.exit(1);
  }
  console.log('GPL/LGPL/AGPL packages: none · unlicensed packages: none · PASS');
}
