import crypto from 'node:crypto';
// Long-running agent for the Swipe Feed phone app (run it under launchd, see launchd/).
// Every 10 s (heartbeat every 30 s): heartbeat, pick up queued requests. Posts go to X through Codex (post-x.mjs); edits and
// batch requests are relayed to your T3 Code thread through its webhook. Syncs renders every 10 min.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { api, authHeaders, cfg, log, run, FEED, LOG_DIR, PIECES } from './lib.mjs';
import { sync } from './sync.mjs';
const TICK = 10000, SYNC_EVERY = 10 * 60000;
let lastSync = 0, busy = '', posting = null;

async function localMedia(itemId) {
  try { const m = JSON.parse(fs.readFileSync(path.join(PIECES, itemId, 'meta.json'), 'utf8')); return path.join(PIECES, itemId, m.media); } catch { return null; }
}
async function status(id, s, extra = {}) { await api('/api/agent/status', {method: 'POST', body: {id, status: s, ...extra}}); }

// Posts that failed without going out are retried with backoff for ~8 h (Codex's Chrome control has outages
// of an hour or more) instead of giving up after a few minutes. Pending retries survive agent restarts.
const BACKOFF_MIN = [1.5, 5, 10, 20, 30, 45, 60, 60, 60, 60, 60, 60, 60];
const RETRY_FILE = path.join(LOG_DIR, 'post-retries.json');
const retries = new Map(Object.entries((() => { try { return JSON.parse(fs.readFileSync(RETRY_FILE, 'utf8')); } catch { return {}; } })()));
const saveRetries = () => fs.writeFileSync(RETRY_FILE, JSON.stringify(Object.fromEntries(retries), null, 1));
const hhmm = t => new Date(t).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit'});

// POSTED LEDGER (Oct 30, after 5 duplicate posts): every caption that went out, or may have gone out, is recorded by a hash
// of its normalized first 200 characters. A request whose caption is already in the ledger (last 14 days) is never posted
// again, whatever the retry or fallback state. An outcome of "posted: null" (unknown) also enters the ledger, so it can't repeat.
const LEDGER_FILE = path.join(LOG_DIR, 'posted-ledger.json');
const capKey = c => crypto.createHash('sha256').update(String(c || '').replace(/\s+/g, ' ').trim().slice(0, 200).toLowerCase()).digest('hex').slice(0, 24);
const ledger = () => { try { return JSON.parse(fs.readFileSync(LEDGER_FILE, 'utf8')); } catch { return {}; } };
const ledgerAdd = (r, res) => { const l = ledger(); l[capKey(r.payload.caption)] = {request: r.id, num: r.num, url: res.url || null, outcome: res.ok ? 'posted' : 'unknown', at: new Date().toISOString()}; fs.writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 1)); };
const ledgerHit = r => { const e = ledger()[capKey(r.payload.caption)]; return e && Date.now() - Date.parse(e.at) < 14 * 864e5 ? e : null; };

// LINKEDIN CROSS-POST (optional): best effort, fully decoupled from X. After an X post succeeds it is queued here; a separate lane posts it
// to LinkedIn later. Nothing in this block can change an X request's status, ledger or retries: every call is caught, the queue is its
// own file, and a LinkedIn post that went out or may have gone out (posted != false) is never retried. Off unless LINKEDIN=1 in .env; also touch linkedin.off in the log folder to pause it
const LI_Q = path.join(LOG_DIR, 'linkedin-queue.json'), LI_OFF = path.join(LOG_DIR, 'linkedin.off'), LI_BACKOFF_MIN = [5, 20, 60, 120];
const liQ = () => { try { return JSON.parse(fs.readFileSync(LI_Q, 'utf8')); } catch { return []; } };
const liSave = q => fs.writeFileSync(LI_Q, JSON.stringify(q, null, 1));
let liBusy = false;
function liEnqueue(r, media) {
  try { if (process.env.LINKEDIN !== '1' || fs.existsSync(LI_OFF)) return;
    const q = liQ(); if (q.some(x => x.key === capKey(r.payload.caption))) return;
    q.push({key: capKey(r.payload.caption), id: r.id, num: r.num, media, caption: r.payload.caption, n: 1, at: Date.now() + 60000, done: null}); liSave(q);
  } catch (e) { log('linkedin enqueue error', e.message); }
}
async function liTick() {
  if (process.env.LINKEDIN !== '1' || liBusy || posting || fs.existsSync(LI_OFF)) return;
  try {
    const q = liQ(), e = q.find(x => !x.done && x.at <= Date.now()); if (!e) return;
    liBusy = true;
    if (!e.media || !fs.existsSync(e.media)) { e.done = 'failed: media missing'; liSave(q); return; }
    const cap = path.join(os.tmpdir(), `feed-li-${e.id}.txt`); fs.writeFileSync(cap, e.caption);
    const {out} = await run(process.execPath, [path.join(FEED, 'agent/linkedin-post.mjs'), e.media, cap], {timeoutMs: 30 * 60000});
    let res = {ok: false, error: 'no result', posted: null};
    try { res = JSON.parse(out.trim().split('\n').filter(l => l.startsWith('{')).pop()); } catch {}
    log('linkedin', e.id, e.n, res);
    const q2 = liQ(), e2 = q2.find(x => x.key === e.key);
    if (e2) { if (res.ok) e2.done = 'posted ' + (res.url || ''); else if (res.posted === false && e2.n <= LI_BACKOFF_MIN.length) { e2.at = Date.now() + LI_BACKOFF_MIN[e2.n - 1] * 60000; e2.n++; } else e2.done = (res.posted === false ? 'failed: ' : 'unknown, check LinkedIn: ') + String(res.error || '').slice(0, 150); liSave(q2.slice(-100)); }
  } catch (err) { log('linkedin error', err.message); } finally { liBusy = false; }
}

async function doPost(r, n = 1) {
  const prior = ledgerHit(r);
  if (prior) { retries.delete(r.id); saveRetries(); log('post blocked by ledger', r.id, prior);
    return status(r.id, prior.outcome === 'posted' ? 'posted' : 'failed', prior.outcome === 'posted' ? {url: prior.url, result: 'already posted (same caption), not posted again'} : {result: 'Same caption may already be on X (earlier attempt had an unknown outcome). Not posted again. Check X.'}); }
  const media = await localMedia(r.item_id);
  if (!media || !fs.existsSync(media)) return status(r.id, 'failed', {result: 'media file not found on this machine'});
  await status(r.id, 'posting', n > 1 ? {result: `Attempt ${n}`} : {});
  const cap = path.join(os.tmpdir(), `feed-cap-${r.id}.txt`); fs.writeFileSync(cap, r.payload.caption);
  busy = `posting #${r.num} (try ${n})`;
  const {out} = await run(process.execPath, [path.join(FEED, 'agent/post-x.mjs'), media, cap], {timeoutMs: 55 * 60000});
  let res = {ok: false, error: 'no result from post-x', posted: null};
  try { res = JSON.parse(out.trim().split('\n').filter(l => l.startsWith('{')).pop()); } catch {}
  log('post', r.id, n, {...res, log: undefined});
  busy = '';
  retries.delete(r.id);
  if (res.ok || res.posted !== false) ledgerAdd(r, res);
  if (res.ok) { liEnqueue(r, media); await status(r.id, 'posted', res.url ? {url: res.url, result: 'posted'} : {result: 'posted (link not found)'}); }
  else if (res.posted === false && n <= BACKOFF_MIN.length) {
    const at = Date.now() + BACKOFF_MIN[n - 1] * 60000;
    retries.set(r.id, {r, n: n + 1, at});
    await status(r.id, 'posting', {result: `Not posted yet, retrying at ${hhmm(at)} (attempt ${n + 1}): ${String(res.error || '').slice(0, 160)}`});
  } else await status(r.id, 'failed', {result: (res.posted === false ? '' : 'Check X before retrying. ') + (res.error || 'failed').slice(0, 300)});
  saveRetries();
}
function startPost(r, n) {
  posting = doPost(r, n).catch(async e => {
    log('request error', r.id, e.message);
    // network blips etc: keep it on the retry track rather than failing outright
    if ((n || 1) <= BACKOFF_MIN.length) { retries.set(r.id, {r, n: (n || 1) + 1, at: Date.now() + 5 * 60000}); saveRetries(); }
    else await status(r.id, 'failed', {result: e.message.slice(0, 300)}).catch(() => {});
  }).finally(() => { posting = null; busy = ''; });
}

// reference images attached in the app: saved under feed/refs/<request id>/ so Claude can open them
async function fetchRefs(r) {
  const keys = r.payload.images || []; if (!keys.length) return [];
  const dir = path.join(FEED, 'refs', r.id); fs.mkdirSync(dir, {recursive: true});
  const c = cfg(), out = [];
  for (const [i, key] of keys.entries()) {
    const res = await fetch(`${c.site}/api/agent/media/${encodeURIComponent(key)}`, {headers: authHeaders(c), signal: AbortSignal.timeout(60000)});
    if (!res.ok) throw new Error(`ref image ${key} -> ${res.status}`);
    const f = path.join(dir, `${i + 1}${path.extname(key) || '.jpg'}`);
    fs.writeFileSync(f, Buffer.from(await res.arrayBuffer())); out.push(f);
  }
  return out;
}

async function relay(r) {
  const refs = await fetchRefs(r);
  const text = (r.payload.text || '') + (refs.length ? `\n\nReference images attached (open each one before starting): ${refs.join(' , ')}` : '');
  const body = {id: r.id, kind: r.kind, piece: r.num ?? '', title: r.title ?? '', text, count: r.kind === 'batch' ? String(r.payload.count || 10) : ''};
  const res = await fetch(cfg().hook, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body), signal: AbortSignal.timeout(30000)});
  if (!res.ok) throw new Error(`webhook ${res.status}`);
  await status(r.id, 'sent');
  log('relayed', r.kind, r.id);
}

const beat = () => api('/api/agent/heartbeat', {method: 'POST', body: {host: os.hostname(), busy, pid: process.pid}}).catch(e => log('heartbeat error', e.message));
setInterval(beat, 30000);

async function tick() {
  // requests left mid-flight by a crash or restart
  for (const r of (await api('/api/agent/stuck')).requests) {
    const age = Date.now() - new Date(r.updated_at);
    if (r.kind === 'post' && ['claimed', 'posting'].includes(r.status) && age > 30 * 60000 && !posting && !retries.has(r.id)) await status(r.id, 'failed', {result: 'Agent restarted while posting. Check X before retrying.'});
    if (r.kind !== 'post' && r.status === 'claimed' && age > 5 * 60000) await status(r.id, 'queued');
  }
  // edits and batches relay right away; posts run one at a time on their own lane so a slow post
  // (can take 15+ min) never holds up relays or the heartbeat
  if (!posting) {
    const due = [...retries.values()].filter(x => x.at <= Date.now()).sort((a, b) => a.at - b.at)[0];
    if (due) startPost(due.r, due.n);
  }
  for (const r of (await api('/api/agent/pending')).requests) {
    if (r.kind === 'post' && posting) continue;
    if (!(await api('/api/agent/claim', {method: 'POST', body: {id: r.id}})).ok) continue;
    if (r.kind === 'post') { startPost(r, 1); continue; }
    try { await relay(r); } catch (e) {
      log('request error', r.id, e.message);
      await status(r.id, 'queued', {result: e.message.slice(0, 300)}).catch(() => {});
    }
  }
  if (Date.now() - lastSync > SYNC_EVERY) { lastSync = Date.now(); await sync({quiet: true}).catch(e => log('sync error', e.message)); }
}

log('agent start', process.pid);
beat();
for (;;) {
  try { await tick(); } catch (e) { log('tick error', e.message); }
  liTick().catch(e => log('linkedin error', e.message));
  await new Promise(r => setTimeout(r, TICK));
}
