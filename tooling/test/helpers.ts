import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const at = (...p: string[]): string => join(REPO, ...p);
export const exists = (...p: string[]): boolean => existsSync(at(...p));
export const readText = (...p: string[]): string => readFileSync(at(...p), 'utf8');
export const readJson = (...p: string[]): unknown => JSON.parse(readText(...p));

export type Obj = Readonly<Record<string, unknown>>;
export const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export function obj(v: unknown, what: string): Obj {
  if (!isObj(v)) throw new Error(`${what} is not a JSON object`);
  return v;
}

export function strings(v: unknown, what: string): string[] {
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === 'string')) throw new Error(`${what} is not a string array`);
  return v;
}

/** The four tools g4stein/SUTURE packages/mcp/src/tools.ts registers (proved live by tooling/scripts/prove-sample.mjs). */
export const SUTURE_TOOLS = ['suture_list_workbooks', 'suture_inspect_lineage', 'suture_run_audit', 'suture_verify_patch'] as const;
export const SUTURE_NPM = '@g4stein/suture-mcp@0.1.0';
