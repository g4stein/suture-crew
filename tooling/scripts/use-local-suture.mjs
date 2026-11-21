#!/usr/bin/env node
// Points a working copy of Suture Crew at a different Suture MCP launcher, before `kirocrew app install ./suture-crew`.
//
//   node tooling/scripts/use-local-suture.mjs --local /abs/path/to/SUTURE    # node <SUTURE>/packages/mcp/dist/suture-mcp.mjs
//   node tooling/scripts/use-local-suture.mjs --npm @your-scope/suture-mcp@0.1.0
//
// Rewrites app.json mcpServers.suture and every agent's suture-sample server; nothing else changes. Run it on your own
// clone, never on the committed main branch (CI checks that the committed files pin @suture/mcp@0.1.0).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string} appRoot
 * @param {{ local?: string, npm?: string }} target
 * @returns {string[]} the files rewritten
 */
export function retarget(appRoot, target) {
  /** @type {{ command: string, args: string[] }} */
  let launch;
  if (target.local !== undefined) {
    if (!isAbsolute(target.local)) throw new Error('--local needs an absolute path to a SUTURE checkout');
    const entry = join(target.local, 'packages', 'mcp', 'dist', 'suture-mcp.mjs');
    if (!existsSync(entry)) throw new Error(`${entry} not found: run "pnpm install && pnpm build" in the SUTURE checkout first`);
    launch = { command: 'node', args: [entry] };
  } else if (target.npm !== undefined) {
    if (!/^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*@\d+\.\d+\.\d+$/.test(target.npm)) throw new Error('--npm needs an exact package spec such as @scope/name@1.2.3');
    launch = { command: 'npx', args: ['-y', target.npm] };
  } else {
    throw new Error('pass --local <SUTURE checkout> or --npm <package@version>');
  }
  const written = [];
  const manifestPath = join(appRoot, 'app.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.mcpServers.suture = { ...manifest.mcpServers.suture, command: launch.command, args: [...launch.args] };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  written.push('app.json');
  for (const rel of manifest.agents) {
    const p = join(appRoot, rel);
    const agent = JSON.parse(readFileSync(p, 'utf8'));
    if (agent.mcpServers?.['suture-sample'] === undefined) continue;
    agent.mcpServers['suture-sample'] = { command: launch.command, args: [...launch.args, '--root', '{APP_ROOT}/samples'] };
    writeFileSync(p, `${JSON.stringify(agent, null, 2)}\n`);
    written.push(rel);
  }
  return written;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const local = flag('--local');
  const npm = flag('--npm');
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  try {
    const files = retarget(root, { ...(local === undefined ? {} : { local: resolve(local) }), ...(npm === undefined ? {} : { npm }) });
    console.log(`Suture launcher updated in: ${files.join(', ')}`);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(2);
  }
}
