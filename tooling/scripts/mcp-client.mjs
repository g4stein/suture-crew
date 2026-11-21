// Minimal stdio MCP client (newline-delimited JSON-RPC 2.0) used by the end-to-end proof and the tests.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

/**
 * Starts `command args` and returns a client. `request` resolves with the JSON-RPC `result`, and rejects on a JSON-RPC
 * error, on process exit, or after `timeoutMs`.
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} [opts]
 */
export function startMcp(command, args, opts = {}) {
  const child = spawn(command, [...args], { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const timeoutMs = opts.timeoutMs ?? 120_000;
  /** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map();
  let stderr = '';
  let nextId = 1;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8000); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (line.trim() === '') return;
    /** @type {{ id?: number, result?: unknown, error?: { code: number, message: string } }} */
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    if (typeof msg.id !== 'number') return;
    const p = pending.get(msg.id);
    if (p === undefined) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error !== undefined) p.reject(Object.assign(new Error(`${msg.error.code}: ${msg.error.message}`), { rpc: msg.error }));
    else p.resolve(msg.result);
  });
  child.on('exit', (code) => {
    for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(`MCP server exited (${code}) before answering. stderr:\n${stderr}`)); }
    pending.clear();
  });

  /** @param {string} method @param {Record<string, unknown>} [params] */
  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out after ${timeoutMs} ms. stderr:\n${stderr}`)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`);
    });
  }
  /** @param {string} method @param {Record<string, unknown>} [params] */
  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })}\n`);
  }
  /** Runs the 2025-11-25 handshake. */
  async function initialize() {
    const result = await request('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'suture-crew-proof', version: '1.0.0' } });
    notify('notifications/initialized');
    return result;
  }
  /** Calls a tool and returns its structuredContent; throws when the tool reports isError. @param {string} name @param {Record<string, unknown>} args */
  async function callTool(name, args) {
    /** @type {{ isError?: boolean, structuredContent?: Record<string, unknown>, content?: Array<{ text?: string }> }} */
    const r = /** @type {never} */ (await request('tools/call', { name, arguments: args }));
    if (r.isError === true) throw new Error(`${name} failed: ${r.content?.[0]?.text ?? 'no message'}`);
    if (r.structuredContent === undefined) throw new Error(`${name} returned no structuredContent`);
    return r.structuredContent;
  }
  function close() {
    child.stdin.end();
    return new Promise((resolve) => {
      if (child.exitCode !== null) { resolve(child.exitCode); return; }
      const kill = setTimeout(() => child.kill('SIGTERM'), 5000);
      child.on('exit', (code) => { clearTimeout(kill); resolve(code); });
    });
  }
  return { request, notify, initialize, callTool, close, get stderr() { return stderr; } };
}
