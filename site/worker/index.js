// Swipe Feed: a phone UI for reviewing drafted posts, plus the queue your always-on agent works from.
// Browser routes need a signed-in owner. /api/agent/* is called by your agent with a token. See AUTH_MODE in docs/hosting.md.
const APP_HTML = "__APP_HTML__";

const now = () => new Date().toISOString();
const json = (data, status = 200) => new Response(JSON.stringify(data), {status, headers: {'content-type': 'application/json', 'cache-control': 'no-store'}});
const bad = (msg, status = 400) => json({error: msg}, status);
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const OPEN_POST = ['queued', 'scheduled', 'claimed', 'posting'];

async function body(request, limit = 64 * 1024) {
  const text = await request.text();
  if (text.length > limit) throw new RangeError('body too large');
  return parse(text) || {};
}

function itemOut(r) {
  return {id: r.id, num: r.num, batch: r.batch, title: r.title, caption: r.caption, alts: parse(r.alts) || [], numbers: r.numbers, source: r.source,
    kind: r.kind, aspect: r.aspect, edited: !!r.edited, media: r.media && '/m/' + r.media, thumb: r.thumb && '/m/' + r.thumb, version: r.version, created: r.created,
    deferred: r.deferred_at || null};
}

// Later + Skipped (2026-10-30) use items.deferred_at / items.restored_at (drizzle 0002). Until that migration is applied the
// columns are missing: the feed falls back to the old query and the agent sync keeps working; only Later/Restore report an error.
let laterCols = false;
async function hasLaterCols(env) {
  if (laterCols) return true;
  try { await env.DB.prepare(`SELECT deferred_at, restored_at FROM items LIMIT 0`).all(); laterCols = true; } catch { laterCols = false; }
  return laterCols;
}

// Undecided first (restored ones on top, then newest), then the ones sent to Later, oldest deferral first.
async function feed(env) {
  const order = (await hasLaterCols(env)) ? `i.deferred_at IS NOT NULL, i.deferred_at, COALESCE(i.restored_at, '') DESC, i.created DESC, i.num DESC` : `i.created DESC, i.num DESC`;
  const {results} = await env.DB.prepare(`SELECT i.* FROM items i LEFT JOIN decisions d ON d.item_id = i.id
    WHERE d.item_id IS NULL AND i.media IS NOT NULL ORDER BY ${order}`).all();
  return results.map(itemOut);
}

// Later: move an undecided card to the back of the queue. No decision row, nothing for the agent.
async function defer(env, b) {
  if (!(await hasLaterCols(env))) return bad('Later needs the new database update, redeploy pending', 503);
  const item = await env.DB.prepare(`SELECT i.id, d.status FROM items i LEFT JOIN decisions d ON d.item_id = i.id WHERE i.id = ?`).bind(String(b.id || '')).first();
  if (!item) return bad('unknown item', 404);
  if (item.status) return bad('already decided', 409);
  let at = now();
  if (b.undo) { const d = b.prev ? new Date(b.prev) : null; at = d && !isNaN(d) ? d.toISOString() : null; }
  await env.DB.prepare(`UPDATE items SET deferred_at = ? WHERE id = ?`).bind(at, item.id).run();
  return json({ok: true, deferred: at});
}

// Skipped: items whose decision is a plain skip ('pass', never a post or edit), newest skip first.
async function skipped(env, url) {
  const offset = Math.max(0, parseInt(url.searchParams.get('offset'), 10) || 0), limit = 50;
  const [{results}, cnt] = await Promise.all([
    env.DB.prepare(`SELECT i.*, d.updated_at AS skipped_at, d.note AS dnote FROM decisions d JOIN items i ON i.id = d.item_id
      WHERE d.status = 'pass' AND d.request_id IS NULL AND i.media IS NOT NULL ORDER BY d.updated_at DESC, i.num DESC LIMIT ? OFFSET ?`).bind(limit, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM decisions d JOIN items i ON i.id = d.item_id WHERE d.status = 'pass' AND d.request_id IS NULL AND i.media IS NOT NULL`).first()]);
  return json({items: results.map(r => ({...itemOut(r), skippedAt: r.skipped_at, imported: r.dnote === 'imported'})), total: cnt?.n || 0, offset, limit});
}

// Restore a skipped item to the feed: only deletes a 'pass' decision with no request, so posted/queued/edit items can't be touched
// and nothing is queued for the agent. restored_at keeps the agent's sync from re-marking it skipped's marks.
async function restore(env, b) {
  if (!(await hasLaterCols(env))) return bad('Restore needs the new database update, redeploy pending', 503);
  const id = String(b.id || ''), t = now();
  const r = await env.DB.prepare(`DELETE FROM decisions WHERE item_id = ? AND status = 'pass' AND request_id IS NULL`).bind(id).run();
  if (!r.meta.changes) return bad('not a skipped item (posted or in progress?)', 409);
  await env.DB.prepare(`UPDATE items SET restored_at = ?, deferred_at = NULL WHERE id = ?`).bind(t, id).run();
  const item = await env.DB.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first();
  return json({ok: true, item: item && itemOut(item)});
}

async function activity(env) {
  const {results} = await env.DB.prepare(`SELECT r.*, i.num, i.title, i.thumb, d.tweet_url, d.caption AS dcaption, d.schedule_at
    FROM requests r LEFT JOIN items i ON i.id = r.item_id LEFT JOIN decisions d ON d.item_id = r.item_id AND d.request_id = r.id
    WHERE r.status != 'canceled' ORDER BY r.created_at DESC LIMIT 80`).all();
  return results.map(r => ({id: r.id, kind: r.kind, status: r.status, result: r.result, itemId: r.item_id, num: r.num, title: r.title,
    thumb: r.thumb && '/m/' + r.thumb, payload: parse(r.payload) || {}, runAt: r.run_at, url: r.tweet_url, created: r.created_at, updated: r.updated_at}));
}

async function agentSeen(env) {
  const row = await env.DB.prepare(`SELECT v, at FROM kv WHERE k = 'agent'`).first();
  return row ? {at: row.at, info: parse(row.v)} : null;
}

// reference images you attach to an edit or batch: keys under refs/ that /api/upload created
const refKeys = v => (Array.isArray(v) ? v : []).filter(k => typeof k === 'string' && /^refs\/[\w.\-\/]+$/.test(k)).slice(0, 8);
async function upload(request, env) {
  const type = (request.headers.get('content-type') || '').split(';')[0].trim();
  const ext = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/heic': 'heic'}[type];
  if (!ext) return bad('images only (jpeg, png, webp, gif, heic)');
  const buf = await request.arrayBuffer();
  if (!buf.byteLength) return bad('empty image');
  if (buf.byteLength > 15 * 1024 * 1024) return bad('image too large (15 MB max)', 413);
  const key = `refs/${now().slice(0, 10)}/${crypto.randomUUID()}.${ext}`;
  await env.BUCKET.put(key, buf, {httpMetadata: {contentType: type}});
  return json({ok: true, key, url: '/m/' + key});
}

async function newRequest(env, kind, itemId, payload, runAt) {
  const id = crypto.randomUUID(), t = now();
  await env.DB.prepare(`INSERT INTO requests (id, kind, item_id, payload, status, run_at, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?)`)
    .bind(id, kind, itemId, JSON.stringify(payload), runAt || t, t, t).run();
  return id;
}

async function decide(env, b) {
  const item = await env.DB.prepare(`SELECT * FROM items WHERE id = ?`).bind(b.id).first();
  if (!item) return bad('unknown item', 404);
  const t = now();
  if (b.action === 'pass') {
    await env.DB.prepare(`INSERT OR REPLACE INTO decisions (item_id, status, version, updated_at) VALUES (?, 'pass', ?, ?)`).bind(item.id, item.version, t).run();
    return json({ok: true});
  }
  if (b.action === 'undo') {
    const d = await env.DB.prepare(`SELECT * FROM decisions WHERE item_id = ?`).bind(item.id).first();
    if (!d) return json({ok: true});
    if (d.request_id) {
      const r = await env.DB.prepare(`UPDATE requests SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'queued'`).bind(t, d.request_id).run();
      if (!r.meta.changes) return bad('already started, cannot undo', 409);
    }
    await env.DB.prepare(`DELETE FROM decisions WHERE item_id = ?`).bind(item.id).run();
    if (await hasLaterCols(env)) await env.DB.prepare(`UPDATE items SET deferred_at = NULL WHERE id = ?`).bind(item.id).run();
    return json({ok: true});
  }
  if (b.action === 'edit') {
    const images = refKeys(b.images);
    const note = String(b.note || '').trim().slice(0, 4000) || (images.length ? '(see the reference images)' : '');
    if (!note) return bad('describe the edit');
    const rid = await newRequest(env, 'edit', item.id, {piece: item.num, title: item.title, text: note, ...(images.length ? {images} : {})});
    await env.DB.prepare(`INSERT OR REPLACE INTO decisions (item_id, status, note, version, request_id, updated_at) VALUES (?, 'edit', ?, ?, ?, ?)`).bind(item.id, note, item.version, rid, t).run();
    return json({ok: true, requestId: rid});
  }
  if (b.action === 'post') {
    const caption = String(b.caption || '').trim();
    if (!caption) return bad('caption is empty');
    if (caption.length > 4000) return bad('caption too long');
    let at = null;
    if (b.scheduleAt) { const d = new Date(b.scheduleAt); if (isNaN(d)) return bad('bad schedule time'); if (tooFar(d)) return bad('that time is more than 60 days out, check the year'); at = d.toISOString(); }
    const rid = await newRequest(env, 'post', item.id, {caption, media: item.media, num: item.num, title: item.title}, at);
    await env.DB.prepare(`INSERT OR REPLACE INTO decisions (item_id, status, caption, schedule_at, version, request_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(item.id, at && at > t ? 'scheduled' : 'queued', caption, at, item.version, rid, t).run();
    return json({ok: true, requestId: rid});
  }
  return bad('unknown action');
}

const FAR = 60 * 24 * 3600e3;
const tooFar = d => d.getTime() - Date.now() > FAR;

async function requestAction(env, b) {
  const r = await env.DB.prepare(`SELECT * FROM requests WHERE id = ?`).bind(b.id).first();
  if (!r) return bad('unknown request', 404);
  const t = now();
  if (b.action === 'cancel') {
    const u = await env.DB.prepare(`UPDATE requests SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'queued'`).bind(t, r.id).run();
    if (!u.meta.changes) return bad('already started', 409);
    if (r.item_id) await env.DB.prepare(`DELETE FROM decisions WHERE item_id = ? AND request_id = ?`).bind(r.item_id, r.id).run();
    return json({ok: true});
  }
  if (b.action === 'retry') {
    if (r.status !== 'failed') return bad('only failed requests can be retried', 409);
    await env.DB.prepare(`UPDATE requests SET status = 'queued', result = NULL, run_at = ?, updated_at = ? WHERE id = ?`).bind(t, t, r.id).run();
    if (r.kind === 'post') await env.DB.prepare(`UPDATE decisions SET status = 'queued', error = NULL, updated_at = ? WHERE request_id = ?`).bind(t, r.id).run();
    return json({ok: true});
  }
  if (b.action === 'reschedule' && r.kind === 'post') {
    const d = new Date(b.scheduleAt); if (isNaN(d)) return bad('bad schedule time');
    if (tooFar(d) && !b.force) return bad('that time is more than 60 days out, check the year');
    const u = await env.DB.prepare(`UPDATE requests SET run_at = ?, updated_at = ? WHERE id = ? AND status = 'queued'`).bind(d.toISOString(), t, r.id).run();
    if (!u.meta.changes) return bad('already started', 409);
    await env.DB.prepare(`UPDATE decisions SET schedule_at = ?, status = 'scheduled', updated_at = ? WHERE request_id = ?`).bind(d.toISOString(), t, r.id).run();
    return json({ok: true});
  }
  return bad('unknown action');
}

// ---- agent routes ----
async function upsertItems(env, items) {
  const t = now(); let added = 0, updated = 0;
  for (let k = 0; k < items.length; k += 40) {
    const chunk = items.slice(k, k + 40);
    const ids = chunk.map(x => x.id);
    const rcol = (await hasLaterCols(env)) ? 'i.restored_at' : 'NULL AS restored_at';
    const {results} = await env.DB.prepare(`SELECT i.id, i.version, ${rcol}, d.status FROM items i LEFT JOIN decisions d ON d.item_id = i.id WHERE i.id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all();
    const have = Object.fromEntries(results.map(r => [r.id, r]));
    const st = [];
    for (const x of chunk) {
      const vals = [x.num ?? null, x.batch ?? null, x.title ?? '', x.caption ?? '', JSON.stringify(x.alts || []), x.numbers ?? '', x.source ?? '', x.kind ?? 'video', x.aspect ?? null, x.media ?? null, x.thumb ?? null, x.version | 0, x.created ?? t, t];
      const h = have[x.id];
      if (!h) {
        added++;
        st.push(env.DB.prepare(`INSERT INTO items (num, batch, title, caption, alts, numbers, source, kind, aspect, media, thumb, version, created, updated_at, id) VALUES (${vals.map(() => '?').join(',')}, ?)`).bind(...vals, x.id));
        if (x.handled) st.push(env.DB.prepare(`INSERT OR IGNORE INTO decisions (item_id, status, note, tweet_url, version, updated_at) VALUES (?, ?, 'imported', ?, ?, ?)`).bind(x.id, x.handled, x.tweetUrl ?? null, x.version | 0, t));
      } else if (h.version !== (x.version | 0)) {
        updated++;
        st.push(env.DB.prepare(`UPDATE items SET num=?, batch=?, title=?, caption=?, alts=?, numbers=?, source=?, kind=?, aspect=?, media=?, thumb=?, version=?, created=?, updated_at=? WHERE id = ?`).bind(...vals, x.id));
        // an edit was requested and a new render arrived: put it back in the feed
        if (h.status === 'edit') {
          st.push(env.DB.prepare(`UPDATE items SET edited = 1 WHERE id = ?`).bind(x.id));
          st.push(env.DB.prepare(`UPDATE requests SET status = 'done', result = COALESCE(result, 'new version synced'), updated_at = ? WHERE item_id = ? AND kind = 'edit' AND status NOT IN ('done', 'failed', 'canceled')`).bind(t, x.id));
          st.push(env.DB.prepare(`DELETE FROM decisions WHERE item_id = ? AND status = 'edit'`).bind(x.id));
        }
      } else if (x.handled && !h.status && !(x.handled === 'pass' && h.restored_at)) {
        st.push(env.DB.prepare(`INSERT OR IGNORE INTO decisions (item_id, status, note, tweet_url, version, updated_at) VALUES (?, ?, 'imported', ?, ?, ?)`).bind(x.id, x.handled, x.tweetUrl ?? null, x.version | 0, t));
      }
    }
    if (st.length) await env.DB.batch(st);
  }
  return {added, updated};
}

async function agentStatus(env, b) {
  const r = await env.DB.prepare(`SELECT * FROM requests WHERE id = ?`).bind(b.id).first();
  if (!r) return bad('unknown request', 404);
  const t = now(), status = String(b.status || '');
  if (!['claimed', 'sent', 'working', 'posting', 'posted', 'done', 'failed', 'queued'].includes(status)) return bad('bad status');
  await env.DB.prepare(`UPDATE requests SET status = ?, result = COALESCE(?, result), attempts = attempts + ?, updated_at = ? WHERE id = ?`)
    .bind(status, b.result ?? null, status === 'failed' ? 1 : 0, t, r.id).run();
  if (r.kind === 'post') {
    const ds = {posting: 'posting', posted: 'posted', done: 'posted', failed: 'failed', queued: 'queued', claimed: 'posting'}[status];
    if (ds) await env.DB.prepare(`UPDATE decisions SET status = ?, tweet_url = COALESCE(?, tweet_url), error = ?, updated_at = ? WHERE request_id = ?`)
      .bind(ds, b.url ?? null, status === 'failed' ? (b.result ?? 'failed') : null, t, r.id).run();
  }
  return json({ok: true});
}

async function serveMedia(request, env, key) {
  const obj = await env.BUCKET.get(key, {range: request.headers, onlyIf: request.headers});
  if (!obj) return new Response('not found', {status: 404});
  const h = new Headers();
  obj.writeHttpMetadata(h);
  h.set('etag', obj.httpEtag);
  h.set('accept-ranges', 'bytes');
  h.set('cache-control', 'private, max-age=31536000, immutable');
  if (!('body' in obj)) return new Response(null, {status: 304, headers: h});
  if (obj.range && request.headers.has('range')) {
    const off = obj.range.offset ?? 0, len = obj.range.length ?? (obj.size - off);
    h.set('content-range', `bytes ${off}-${off + len - 1}/${obj.size}`);
    h.set('content-length', String(len));
    return new Response(obj.body, {status: 206, headers: h});
  }
  h.set('content-length', String(obj.size));
  return new Response(obj.body, {headers: h});
}

// Auth. sites: ChatGPT Sites vouches for the owner and for its service token before the request gets here.
// cloudflare-access: Cloudflare Access must protect the site except /api/agent/*, which uses AGENT_TOKEN.
// Either way, set OWNER_EMAIL so only you pass. Trusting these headers without the platform in front would let anyone in.
function ownerAllowed(request, env) {
  const h = env.AUTH_MODE === 'sites' ? 'oai-authenticated-user-email' : 'cf-access-authenticated-user-email';
  const who = (request.headers.get(h) || '').toLowerCase();
  return !!who && (!env.OWNER_EMAIL || who === String(env.OWNER_EMAIL).toLowerCase());
}
function agentAllowed(request, env) {
  if (env.AUTH_MODE === 'sites') return true; // Sites only lets this through for the signed-in owner or the service token
  return !!env.AGENT_TOKEN && request.headers.get('authorization') === `Bearer ${env.AGENT_TOKEN}`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url), p = url.pathname, m = request.method;
    try {
      if (!['sites', 'cloudflare-access'].includes(env.AUTH_MODE)) return bad('Set AUTH_MODE to sites or cloudflare-access. See docs/hosting.md.', 503);
      if (p.startsWith('/m/') && m === 'GET' && !ownerAllowed(request, env) && !agentAllowed(request, env)) return bad('sign in required', 401);
      if (p.startsWith('/m/') && m === 'GET') return serveMedia(request, env, decodeURIComponent(p.slice(3)));

      if (p.startsWith('/api/agent/')) {
        if (!agentAllowed(request, env)) return bad('agent token required', 401);
        if (p === '/api/agent/items' && m === 'POST') return json({ok: true, ...(await upsertItems(env, (await body(request, 4 * 1024 * 1024)).items || []))});
        if (p === '/api/agent/media-keys' && m === 'GET') {
          const keys = []; let cursor;
          do { const l = await env.BUCKET.list({cursor, limit: 1000}); keys.push(...l.objects.map(o => o.key)); cursor = l.truncated ? l.cursor : null; } while (cursor);
          return json({keys});
        }
        if (p.startsWith('/api/agent/media/') && m === 'PUT') {
          const key = decodeURIComponent(p.slice('/api/agent/media/'.length));
          if (!/^[\w.\-\/]+$/.test(key)) return bad('bad key');
          await env.BUCKET.put(key, request.body, {httpMetadata: {contentType: request.headers.get('content-type') || 'application/octet-stream'}});
          return json({ok: true});
        }
        if (p.startsWith('/api/agent/media/') && m === 'GET') return serveMedia(request, env, decodeURIComponent(p.slice('/api/agent/media/'.length)));
        if (p === '/api/agent/pending' && m === 'GET') {
          const {results} = await env.DB.prepare(`SELECT r.*, i.num, i.media, i.title FROM requests r LEFT JOIN items i ON i.id = r.item_id
            WHERE r.status = 'queued' AND (r.run_at IS NULL OR r.run_at <= ?) ORDER BY r.run_at, r.created_at LIMIT 20`).bind(now()).all();
          return json({requests: results.map(r => ({...r, payload: parse(r.payload) || {}}))});
        }
        if (p === '/api/agent/scheduled' && m === 'GET') {
          const {results} = await env.DB.prepare(`SELECT r.id, r.item_id, r.run_at, r.payload, i.num, i.title FROM requests r LEFT JOIN items i ON i.id = r.item_id
            WHERE r.kind = 'post' AND r.status = 'queued' AND r.run_at > ? ORDER BY r.run_at`).bind(now()).all();
          return json({requests: results.map(r => ({...r, payload: parse(r.payload) || {}}))});
        }
        if (p === '/api/agent/reschedule' && m === 'POST') { const b = await body(request); return requestAction(env, {id: b.id, action: 'reschedule', scheduleAt: b.runAt, force: true}); }
        if (p === '/api/agent/stuck' && m === 'GET') {
          const {results} = await env.DB.prepare(`SELECT * FROM requests WHERE status IN ('claimed', 'posting', 'sent', 'working') ORDER BY updated_at`).all();
          return json({requests: results.map(r => ({...r, payload: parse(r.payload) || {}}))});
        }
        if (p === '/api/agent/claim' && m === 'POST') {
          const b = await body(request);
          const r = await env.DB.prepare(`UPDATE requests SET status = 'claimed', updated_at = ? WHERE id = ? AND status = 'queued'`).bind(now(), b.id).run();
          if (r.meta.changes) await env.DB.prepare(`UPDATE decisions SET status = 'posting', updated_at = ? WHERE request_id = ? AND status IN ('queued', 'scheduled')`).bind(now(), b.id).run();
          return json({ok: r.meta.changes === 1});
        }
        if (p === '/api/agent/status' && m === 'POST') return agentStatus(env, await body(request));
        if (p === '/api/agent/heartbeat' && m === 'POST') {
          await env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v, at) VALUES ('agent', ?, ?)`).bind(JSON.stringify(await body(request)), now()).run();
          return json({ok: true});
        }
        return bad('not found', 404);
      }

      if (p === '/' || p === '/index.html') return new Response(APP_HTML, {headers: {'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store'}});
      if (p === '/manifest.webmanifest') return json({name: 'Swipe Feed', short_name: 'Feed', start_url: '/', display: 'standalone', background_color: '#0a0a0a', theme_color: '#0a0a0a'});

      if (p.startsWith('/api/')) {
        if (!ownerAllowed(request, env)) return bad('sign in required', 401);
        if (p === '/api/feed' && m === 'GET') {
          const [items, agent, open] = await Promise.all([feed(env), agentSeen(env),
            env.DB.prepare(`SELECT COUNT(*) AS n, SUM(status = 'failed') AS f FROM requests WHERE status NOT IN ('done', 'posted', 'canceled')`).first()]);
          return json({items, agent, open: open?.n || 0, failed: open?.f || 0});
        }
        // Cheap change check the open app polls every few seconds; it fetches /api/feed only when feed changes.
        if (p === '/api/pulse' && m === 'GET') {
          const later = (await hasLaterCols(env)) ? `, MAX(i.deferred_at) AS da, MAX(i.restored_at) AS ra` : '';
          const [f, r, agent] = await Promise.all([
            env.DB.prepare(`SELECT COUNT(*) AS n, MAX(i.version) AS v, MAX(i.updated_at) AS u${later} FROM items i LEFT JOIN decisions d ON d.item_id = i.id WHERE d.item_id IS NULL AND i.media IS NOT NULL`).first(),
            env.DB.prepare(`SELECT COUNT(*) AS n, MAX(updated_at) AS u, SUM(status NOT IN ('done', 'posted', 'canceled')) AS o, SUM(status = 'failed' AND status NOT IN ('done', 'posted', 'canceled')) AS x FROM requests`).first(),
            agentSeen(env)]);
          return json({feed: [f.n, f.v, f.u, f.da, f.ra].join('|'), reqs: [r.n, r.u].join('|'), agent, open: r.o || 0, failed: r.x || 0});
        }
        if (p === '/api/activity' && m === 'GET') return json({requests: await activity(env), agent: await agentSeen(env)});
        if (p === '/api/decide' && m === 'POST') return decide(env, await body(request));
        if (p === '/api/defer' && m === 'POST') return defer(env, await body(request));
        if (p === '/api/skipped' && m === 'GET') return skipped(env, url);
        if (p === '/api/restore' && m === 'POST') return restore(env, await body(request));
        if (p === '/api/request' && m === 'POST') return requestAction(env, await body(request));
        if (p === '/api/upload' && m === 'POST') return upload(request, env);
        if (p === '/api/batch' && m === 'POST') {
          const b = await body(request), count = Math.max(1, Math.min(40, parseInt(b.count, 10) || 10));
          const images = refKeys(b.images);
          const id = await newRequest(env, 'batch', null, {text: String(b.text || '').trim().slice(0, 4000), count, ...(images.length ? {images} : {})});
          return json({ok: true, requestId: id});
        }
        return bad('not found', 404);
      }
      return new Response('not found', {status: 404});
    } catch (e) {
      return bad(e instanceof RangeError ? e.message : 'server error: ' + (e && e.message), e instanceof RangeError ? 413 : 500);
    }
  },
};
