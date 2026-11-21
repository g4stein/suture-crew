#!/usr/bin/env node
// Digest-based trademark scan. Text is split into lowercase words (also at camelCase boundaries) and adjacent word
// pairs; each is hashed with SHA-256 and compared with tooling/fixtures/banned-term-digests.json (the list
// g4stein/SUTURE uses). Hits are reported by file, line and column, never by term, so no banned term is ever written by
// the scanner, its tests, or its output.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIGEST_FILE = 'tooling/fixtures/banned-term-digests.json';
const BINARY = /\.(png|jpe?g|gif|webp|ico|woff2?|ttf|zip|gz|wasm)$/i;

/** @returns {Set<string>} */
export function loadDigests() {
  const raw = JSON.parse(readFileSync(join(repo, DIGEST_FILE), 'utf8'));
  return new Set(raw.digests);
}

/** @param {string} s */
export const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** @param {string} text @param {Set<string>} digests @returns {Array<{ line: number, column: number, digest: string }>} */
export function scanText(text, digests) {
  const hits = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    /** @type {Array<{ w: string, col: number }>} */
    const words = [];
    for (const m of line.matchAll(/[A-Za-z0-9]+/g)) words.push({ w: m[0].toLowerCase(), col: (m.index ?? 0) + 1 });
    for (let j = 0; j < words.length; j++) {
      const a = words[j];
      if (a === undefined) continue;
      const single = sha256(a.w);
      if (digests.has(single)) hits.push({ line: i + 1, column: a.col, digest: single });
      const b = words[j + 1];
      if (b !== undefined) {
        const pair = sha256(`${a.w} ${b.w}`);
        if (digests.has(pair)) hits.push({ line: i + 1, column: a.col, digest: pair });
      }
    }
  }
  return hits;
}

/** Tracked and untracked-but-not-ignored files: everything a commit could contain. */
export function repoFiles() {
  const out = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8' });
  return [...new Set(out.split('\0').filter((f) => f !== ''))].sort();
}

/** @returns {Array<{ file: string, line: number, column: number }>} */
export function scanRepo() {
  const digests = loadDigests();
  const hits = [];
  for (const file of repoFiles()) {
    if (file === DIGEST_FILE || BINARY.test(file)) continue;
    let text;
    try { text = readFileSync(join(repo, file), 'utf8'); } catch { continue; }
    for (const h of scanText(text, digests)) hits.push({ file, line: h.line, column: h.column });
  }
  return hits;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = repoFiles().length;
  const hits = scanRepo();
  if (hits.length > 0) {
    console.error(`trademark scan: ${hits.length} hit(s):\n${hits.map((h) => `  ${h.file}:${h.line}:${h.column}`).join('\n')}`);
    process.exit(1);
  }
  console.log(`trademark scan: ${files} files, 0 hits · PASS`);
}
