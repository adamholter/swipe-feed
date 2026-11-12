// Shared helpers: config from .env in the repo root, Site API calls, a child-process runner.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
export const FEED = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
for (const line of (fs.existsSync(path.join(FEED, '.env')) ? fs.readFileSync(path.join(FEED, '.env'), 'utf8') : '').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}
export const PIECES = path.resolve(FEED, process.env.PIECES_DIR || 'pieces');
export const LOG_DIR = path.resolve((process.env.LOG_DIR || path.join(process.env.HOME, 'Library/Logs/swipe-feed')).replace(/^~/, process.env.HOME));
fs.mkdirSync(LOG_DIR, {recursive: true});
export const X_HANDLE = process.env.X_HANDLE || '';
export const POST_MODEL = process.env.POST_MODEL || 'gpt-6.1-terra';
export const cfg = () => ({site: (process.env.FEED_URL || '').replace(/\/$/, ''), token: process.env.FEED_TOKEN || '', hook: process.env.T3_WEBHOOK_URL || ''});
// ChatGPT Sites takes its service token in its own header; other hosts use a normal bearer token.
export const authHeaders = (c = cfg()) => process.env.AUTH_MODE === 'sites' ? {'OAI-Sites-Authorization': `Bearer ${c.token}`} : {authorization: `Bearer ${c.token}`};
export function log(...a) { const line = `${new Date().toISOString()} ${a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ')}`; console.log(line); fs.appendFileSync(path.join(LOG_DIR, 'agent.log'), line + '\n'); }
export async function api(p, {method = 'GET', body, raw, headers = {}, timeout = 60000} = {}) {
  const c = cfg();
  for (let attempt = 1; ; attempt++) {
    try {
      const r = await fetch(c.site + p, {method, headers: {...authHeaders(c), ...(body && !raw ? {'content-type': 'application/json'} : {}), ...headers}, body: raw ?? (body ? JSON.stringify(body) : undefined), signal: AbortSignal.timeout(timeout)});
      if (!r.ok) throw Object.assign(new Error(`${method} ${p} -> ${r.status} ${(await r.text()).slice(0, 200)}`), {status: r.status});
      const ct = r.headers.get('content-type') || '';
      return ct.includes('json') ? r.json() : r.text();
    } catch (e) {
      if (attempt >= 4 || (e.status && e.status < 500 && e.status !== 429)) throw e;
      await new Promise(r => setTimeout(r, 2000 * attempt));
    }
  }
}
// run a command with a hard timeout, resolving {code, out}
export function run(cmd, args, {timeoutMs = 15 * 60000, cwd, input, onSpawn} = {}) {
  return new Promise(res => {
    const ch = spawn(cmd, args, {cwd, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'pipe'], env: {...process.env, PATH: `/opt/homebrew/bin:${process.env.HOME}/.local/bin:/usr/local/bin:${process.env.PATH}`}});
    onSpawn?.(ch);
    let out = ''; ch.stdout.on('data', d => out += d); ch.stderr.on('data', d => out += d);
    if (input) { ch.stdin.write(input); ch.stdin.end(); }
    const t = setTimeout(() => { ch.kill('SIGTERM'); out += '\n[timeout]'; }, timeoutMs);
    ch.on('close', code => { clearTimeout(t); res({code, out}); });
  });
}
