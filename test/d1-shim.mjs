// An in-memory stand-in for the Worker's D1 and R2 bindings, built on node:sqlite with every drizzle migration applied.
// Tests import the built Worker (site/dist/server/index.js), so run `npm run build` in site/ first.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
export const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
export const OWNER = 'owner@example.com', TOKEN = 'test-agent-token';

export function makeEnv(authMode, {migrations = 99, vars = {}} = {}) {
  const db = new DatabaseSync(':memory:'), dir = path.join(ROOT, 'site/drizzle');
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort().slice(0, migrations))
    for (const st of fs.readFileSync(path.join(dir, f), 'utf8').split('--> statement-breakpoint')) if (st.trim()) db.exec(st);
  const wrap = (sql, args = []) => ({
    bind: (...a) => wrap(sql, a),
    all: async () => ({results: db.prepare(sql).all(...args)}),
    first: async () => db.prepare(sql).get(...args) ?? null,
    run: async () => ({meta: {changes: db.prepare(sql).run(...args).changes}}),
  });
  const files = new Map();
  const BUCKET = {
    put: async (k, v) => { files.set(k, v); },
    get: async () => null,
    list: async () => ({objects: [...files.keys()].map(key => ({key})), truncated: false}),
  };
  return {db, env: {DB: {prepare: s => wrap(s), batch: async sts => { const out = []; for (const s of sts) out.push(await s.run()); return out; }}, BUCKET, AUTH_MODE: authMode, OWNER_EMAIL: OWNER, AGENT_TOKEN: TOKEN, ...vars}};
}

// Headers each platform would add for the signed-in owner and for the agent.
export const ownerHeaders = mode => mode === 'sites' ? {'oai-authenticated-user-email': OWNER} : {'cf-access-authenticated-user-email': OWNER};
export const agentHeaders = mode => mode === 'sites' ? {'oai-authenticated-user-email': OWNER} : {authorization: `Bearer ${TOKEN}`};

export async function loadWorker() {
  const f = path.join(ROOT, 'site/dist/server/index.js');
  if (!fs.existsSync(f)) throw new Error('Build the site first: cd site && npm run build');
  return (await import(f + '?t=' + Date.now() + Math.random())).default; // a fresh module each time, so its cached schema checks don't carry over
}

export function caller(worker, env, mode) {
  return async (p, body, {method = body === undefined ? 'GET' : 'POST', as = p.startsWith('/api/agent/') ? 'agent' : 'owner', headers} = {}) => {
    const h = headers ?? (as === 'agent' ? agentHeaders(mode) : as === 'owner' ? ownerHeaders(mode) : {});
    const r = await worker.fetch(new Request('https://feed.test' + p, {method, headers: {'content-type': 'application/json', ...h}, body: method === 'GET' ? undefined : JSON.stringify(body ?? {})}), env);
    const j = await r.json().catch(() => ({}));
    return {status: r.status, ...j};
  };
}

export function checker() {
  let pass = 0, fail = 0;
  const ok = (c, msg) => { if (c) pass++; else { fail++; console.log('FAIL ' + msg); process.exitCode = 1; } };
  return {ok, done: name => { console.log(`${name}: ${pass} passed, ${fail} failed`); return fail; }};
}
