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
    deferred: r.deferred_at || null, inThread: r.tstatus || null, quote: parse(r.quote) || null};
}

// Later + Skipped use items.deferred_at / items.restored_at (drizzle 0002). Until that migration is applied the
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
  const threads = await hasThreads(env);
  // A thread does not hide its pieces. Each piece stays its own card with its own caption; the card shows which thread it is in.
  const {results} = await env.DB.prepare(`SELECT i.*, (SELECT v FROM kv WHERE k = 'quote:' || i.id) AS quote${threads ? ', t.status AS tstatus' : ''} FROM items i LEFT JOIN decisions d ON d.item_id = i.id${threads ? ' LEFT JOIN threads t ON t.id = i.thread_id' : ''}
    WHERE d.item_id IS NULL AND i.media IS NOT NULL ORDER BY ${order}`).all();
  const items = results.map(itemOut);
  if (!threads) return items;
  // A drafted thread is one card. Fresh threads lead the queue; a deferred thread goes behind the undeferred cards.
  const {results: ts} = await env.DB.prepare(`SELECT * FROM threads WHERE status = 'draft' ORDER BY deferred_at IS NOT NULL, deferred_at, created_at DESC`).all();
  const cards = [];
  for (const t of ts) cards.push(await threadOut(env, t));
  return [...cards.filter(c => !c.deferred), ...items.filter(i => !i.deferred), ...cards.filter(c => c.deferred), ...items.filter(i => i.deferred)];
}

// ---- threads: several pieces drafted, edited and posted as one X thread (drizzle 0003) ----
// threads.parts is the source of truth for order and text: [{itemId|null, text, url?}]. A thread is independent of its pieces:
// they stay in the feed, a thread's post/skip writes no decisions for them, and a piece can sit in several threads. items.thread_id only
// points at the newest thread using the piece, for the card's tag.
let threadCols = false;
async function hasThreads(env) {
  if (threadCols) return true;
  try { await env.DB.prepare(`SELECT 1 FROM threads LIMIT 0`).all(); await env.DB.prepare(`SELECT thread_id FROM items LIMIT 0`).all(); threadCols = true; } catch { threadCols = false; }
  return threadCols;
}
const MAX_PARTS = 25;
// Longest caption or thread post the app accepts. 25,000 is X Premium's limit; set CAPTION_MAX=280 for an account without it.
const capMax = env => { const n = parseInt(env.CAPTION_MAX, 10); return n > 0 ? n : 25000; };
async function itemsById(env, ids) {
  const out = {}, list = [...new Set(ids.filter(Boolean))];
  for (let k = 0; k < list.length; k += 40) {
    const chunk = list.slice(k, k + 40);
    const {results} = await env.DB.prepare(`SELECT i.*, d.status AS dstatus, d.request_id AS drequest FROM items i LEFT JOIN decisions d ON d.item_id = i.id WHERE i.id IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const r of results) out[r.id] = r;
  }
  return out;
}
async function threadOut(env, t) {
  const parts = parse(t.parts) || [], items = await itemsById(env, parts.map(p => p.itemId));
  return {id: 'thread:' + t.id, thread: true, threadId: t.id, title: t.title || 'Thread', batch: t.batch, status: t.status, version: t.version,
    deferred: t.deferred_at || null, created: t.created_at, updated: t.updated_at, url: t.url || null,
    parts: parts.map(p => { const i = p.itemId && items[p.itemId]; return {itemId: p.itemId || null, text: p.text || '', url: p.url || null, ...(i ? {num: i.num, kind: i.kind, aspect: i.aspect, itemTitle: i.title, media: i.media && '/m/' + i.media, thumb: i.thumb && '/m/' + i.thumb, alts: parse(i.alts) || [], numbers: i.numbers, source: i.source} : {})}; })};
}
const threadRow = (env, id) => env.DB.prepare(`SELECT * FROM threads WHERE id = ?`).bind(String(id || '')).first();
// Clean incoming parts. Any synced piece may be used, decided or not, in any number of threads.
async function cleanParts(env, t, raw) {
  if (!Array.isArray(raw) || !raw.length) return {error: 'a thread needs at least one post'};
  if (raw.length > MAX_PARTS) return {error: `${MAX_PARTS} posts at most`};
  const items = await itemsById(env, raw.map(p => p && p.itemId)), seen = new Set(), parts = [], max = capMax(env);
  for (const p of raw) {
    const itemId = p && p.itemId ? String(p.itemId) : null, text = String((p && p.text) ?? '').slice(0, max + 1);
    if (text.length > max) return {error: `a post is over ${max.toLocaleString('en-US')} characters`};
    if (itemId) {
      const i = items[itemId]; if (!i) return {error: 'unknown piece ' + itemId};
      if (seen.has(itemId)) return {error: `#${i.num} is in the thread twice`};
      seen.add(itemId);
    }
    parts.push({itemId, text});
  }
  return {parts};
}
async function writeParts(env, t, parts, extra = {}) {
  const at = now(), old = (parse(t.parts) || []).map(p => p.itemId).filter(Boolean), keep = new Set(parts.map(p => p.itemId).filter(Boolean));
  const st = [env.DB.prepare(`UPDATE threads SET parts = ?, title = COALESCE(?, title), version = version + 1, updated_at = ? WHERE id = ?`).bind(JSON.stringify(parts), extra.title ?? null, at, t.id)];
  for (const id of old) if (!keep.has(id)) st.push(env.DB.prepare(`UPDATE items SET thread_id = NULL WHERE id = ? AND thread_id = ?`).bind(id, t.id));
  for (const id of keep) st.push(env.DB.prepare(`UPDATE items SET thread_id = ? WHERE id = ?`).bind(t.id, id));
  await env.DB.batch(st);
}
async function threadAction(env, b) {
  if (!(await hasThreads(env))) return bad('Threads need the 0003 database migration', 503);
  if (b.action === 'make') {
    // The pieces you picked, in the order given, each with its own caption as the starting text. Old clients send only itemId.
    const ids = [...new Set((Array.isArray(b.itemIds) && b.itemIds.length ? b.itemIds : [b.itemId]).map(String).filter(Boolean))].slice(0, MAX_PARTS);
    if (!ids.length) return bad('pick at least one piece');
    const items = await itemsById(env, ids), miss = ids.find(id => !items[id]); if (miss) return bad('unknown piece ' + miss);
    const first = items[ids[0]], id = crypto.randomUUID(), at = now(), parts = ids.map(i => ({itemId: i, text: items[i].caption || items[i].title || ''}));
    const title = String(b.title || first.batch || 'Thread').slice(0, 200);
    await env.DB.prepare(`INSERT INTO threads (id, title, batch, parts, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)`).bind(id, title, first.batch ?? null, JSON.stringify(parts), at, at).run();
    await env.DB.batch(parts.map(p => env.DB.prepare(`UPDATE items SET thread_id = ? WHERE id = ?`).bind(id, p.itemId)));
    return json({ok: true, thread: await threadOut(env, await threadRow(env, id))});
  }
  const t = await threadRow(env, b.id);
  if (!t) return bad('unknown thread', 404);
  const parts0 = parse(t.parts) || [], ids0 = parts0.map(p => p.itemId).filter(Boolean), at = now();
  if (b.action === 'undoskip') {
    if (t.status !== 'skipped') return bad('thread is not skipped', 409);
    await env.DB.prepare(`UPDATE threads SET status = 'draft', updated_at = ? WHERE id = ?`).bind(at, t.id).run();
    return json({ok: true});
  }
  if (b.action === 'undopost') {
    if (!t.request_id) return bad('nothing to undo', 409);
    return requestAction(env, {id: t.request_id, action: 'cancel'});
  }
  if (t.status !== 'draft') return bad(`thread is already ${t.status}`, 409);
  if (b.action === 'save') {
    const c = await cleanParts(env, t, b.parts); if (c.error) return bad(c.error);
    await writeParts(env, t, c.parts, {title: b.title ? String(b.title).slice(0, 200) : null});
    return json({ok: true, thread: await threadOut(env, await threadRow(env, t.id))});
  }
  if (b.action === 'defer') {
    const d = b.undo && b.prev ? new Date(b.prev) : null, val = b.undo ? (d && !isNaN(d) ? d.toISOString() : null) : at;
    await env.DB.prepare(`UPDATE threads SET deferred_at = ?, updated_at = ? WHERE id = ?`).bind(val, at, t.id).run();
    return json({ok: true, deferred: val});
  }
  if (b.action === 'split') {
    await env.DB.batch([...ids0.map(id => env.DB.prepare(`UPDATE items SET thread_id = NULL WHERE id = ? AND thread_id = ?`).bind(id, t.id)),
      env.DB.prepare(`UPDATE threads SET status = 'split', updated_at = ? WHERE id = ?`).bind(at, t.id)]);
    return json({ok: true});
  }
  if (b.action === 'skip') {
    await env.DB.prepare(`UPDATE threads SET status = 'skipped', updated_at = ? WHERE id = ?`).bind(at, t.id).run(); // the pieces keep their own cards
    return json({ok: true});
  }
  if (b.action === 'edit') {
    const images = refKeys(b.images), note = String(b.note || '').trim().slice(0, 4000) || (images.length ? '(see the reference images)' : '');
    if (!note) return bad('describe the edit');
    const rid = await newRequest(env, 'edit', null, {thread: t.id, title: t.title, text: note, ...(images.length ? {images} : {})});
    return json({ok: true, requestId: rid});
  }
  if (b.action === 'post') {
    const c = await cleanParts(env, t, b.parts || parts0); if (c.error) return bad(c.error);
    if (c.parts.some(p => !p.text.trim() && !p.itemId)) return bad('a text post is empty');
    if (!c.parts[0].text.trim()) return bad('the first post needs text');
    let run = null;
    if (b.scheduleAt) { const d = new Date(b.scheduleAt); if (isNaN(d)) return bad('bad schedule time'); if (tooFar(d)) return bad('that time is more than 60 days out, check the year'); run = d.toISOString(); }
    await writeParts(env, t, c.parts, {title: b.title ? String(b.title).slice(0, 200) : null});
    const items = await itemsById(env, c.parts.map(p => p.itemId));
    const payloadParts = c.parts.map(p => ({itemId: p.itemId, num: p.itemId ? items[p.itemId].num : null, text: p.text.trim()}));
    const rid = await newRequest(env, 'thread', null, {threadId: t.id, title: t.title, parts: payloadParts, caption: payloadParts[0].text}, run || holdUntil());
    // No decisions for the pieces: posting a thread leaves each piece's own card in the feed.
    await env.DB.prepare(`UPDATE threads SET status = 'queued', request_id = ?, updated_at = ? WHERE id = ?`).bind(rid, at, t.id).run();
    return json({ok: true, requestId: rid});
  }
  return bad('unknown action');
}
// Agent: create or replace a drafted thread. Parts name pieces by number. Pieces not yet synced are returned as `skipped`.
async function agentThread(env, b) {
  if (!(await hasThreads(env))) return bad('threads table missing, apply the 0003 database migration', 503);
  const id = String(b.id || '').trim(); if (!/^[\w.\-]{1,80}$/.test(id)) return bad('bad thread id');
  const at = now(), want = Array.isArray(b.parts) ? b.parts : [], nums = want.map(p => p.num).filter(n => n != null);
  const byNum = {};
  for (let k = 0; k < nums.length; k += 40) {
    const chunk = nums.slice(k, k + 40);
    const {results} = await env.DB.prepare(`SELECT i.id, i.num, d.status AS dstatus, i.thread_id FROM items i LEFT JOIN decisions d ON d.item_id = i.id WHERE i.num IN (${chunk.map(() => '?').join(',')})`).bind(...chunk).all();
    for (const r of results) byNum[r.num] = r;
  }
  const skipped = [], raw = [];
  for (const p of want) {
    if (p.num == null) { raw.push({itemId: null, text: p.text}); continue; }
    const i = byNum[p.num];
    if (!i) { skipped.push({num: p.num, why: 'not in the feed yet'}); continue; }
    raw.push({itemId: i.id, text: p.text});
  }
  let t = await threadRow(env, id);
  if (t && t.status !== 'draft') return bad(`thread is already ${t.status}`, 409);
  if (!t && !raw.length) return bad('a thread needs at least one post'); // no empty ghost card when nothing is published yet
  if (!t) {
    await env.DB.prepare(`INSERT INTO threads (id, title, batch, parts, status, created_at, updated_at) VALUES (?, ?, ?, '[]', 'draft', ?, ?)`).bind(id, b.title ? String(b.title).slice(0, 200) : 'Thread', b.batch ?? null, at, at).run();
    t = await threadRow(env, id);
  }
  const c = await cleanParts(env, t, raw); if (c.error) return bad(c.error);
  await writeParts(env, t, c.parts, {title: b.title ? String(b.title).slice(0, 200) : null});
  return json({ok: true, id, skipped, thread: await threadOut(env, await threadRow(env, id))});
}
// Agent: split a drafted thread back into separate cards. Each piece keeps the text it had in the thread.
async function agentThreadSplit(env, b) {
  if (!(await hasThreads(env))) return bad('threads table missing, apply the 0003 database migration', 503);
  const t = await threadRow(env, b.id); if (!t) return bad('unknown thread', 404);
  if (t.status !== 'draft') return bad(`thread is already ${t.status}`, 409);
  const ps = (parse(t.parts) || []).filter(p => p.itemId && String(p.text || '').trim());
  if (ps.length) await env.DB.batch(ps.map(p => env.DB.prepare(`UPDATE items SET caption = ? WHERE id = ?`).bind(p.text.trim(), p.itemId)));
  return threadAction(env, {id: t.id, action: 'split'});
}
// Agent: one part of a thread went out.
async function agentThreadPart(env, b) {
  if (!(await hasThreads(env))) return bad('threads table missing, apply the 0003 database migration', 503);
  const r = await env.DB.prepare(`SELECT * FROM requests WHERE id = ?`).bind(String(b.requestId || '')).first();
  if (!r || r.kind !== 'thread') return bad('unknown thread request', 404);
  const tid = (parse(r.payload) || {}).threadId, t = await threadRow(env, tid); if (!t) return bad('unknown thread', 404);
  const parts = parse(t.parts) || [], p = parts[b.index | 0]; if (!p) return bad('unknown part');
  p.url = b.url || null;
  const at = now(), st = [env.DB.prepare(`UPDATE threads SET parts = ?, url = COALESCE(url, ?), updated_at = ? WHERE id = ?`).bind(JSON.stringify(parts), b.url ?? null, at, t.id)];
  if (p.itemId) st.push(env.DB.prepare(`UPDATE decisions SET status = 'posted', tweet_url = ?, error = NULL, updated_at = ? WHERE item_id = ? AND request_id = ?`).bind(b.url ?? null, at, p.itemId, r.id));
  await env.DB.batch(st);
  return json({ok: true});
}

// Later: move an undecided card to the back of the queue. No decision row, nothing for the agent.
async function defer(env, b) {
  if (!(await hasLaterCols(env))) return bad('Later needs the 0002 database migration', 503);
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
    env.DB.prepare(`SELECT i.*, (SELECT v FROM kv WHERE k = 'quote:' || i.id) AS quote, d.updated_at AS skipped_at, d.note AS dnote FROM decisions d JOIN items i ON i.id = d.item_id
      WHERE d.status = 'pass' AND d.request_id IS NULL AND i.media IS NOT NULL ORDER BY d.updated_at DESC, i.num DESC LIMIT ? OFFSET ?`).bind(limit, offset).all(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM decisions d JOIN items i ON i.id = d.item_id WHERE d.status = 'pass' AND d.request_id IS NULL AND i.media IS NOT NULL`).first()]);
  return json({items: results.map(r => ({...itemOut(r), skippedAt: r.skipped_at, imported: r.dnote === 'imported'})), total: cnt?.n || 0, offset, limit});
}

// Restore a skipped item to the feed: only deletes a 'pass' decision with no request, so posted/queued/edit items can't be touched
// and nothing is queued for the agent. restored_at keeps the agent's sync from re-importing an old skip mark for it.
async function restore(env, b) {
  if (!(await hasLaterCols(env))) return bad('Restore needs the 0002 database migration', 503);
  const id = String(b.id || ''), t = now();
  const r = await env.DB.prepare(`DELETE FROM decisions WHERE item_id = ? AND status = 'pass' AND request_id IS NULL`).bind(id).run();
  if (!r.meta.changes) return bad('not a skipped item (posted or in progress?)', 409);
  await env.DB.prepare(`UPDATE items SET restored_at = ?, deferred_at = NULL WHERE id = ?`).bind(t, id).run();
  const item = await env.DB.prepare(`SELECT * FROM items WHERE id = ?`).bind(id).first();
  return json({ok: true, item: item && itemOut(item)});
}

async function activity(env) {
  const threads = await hasThreads(env);
  const {results} = await env.DB.prepare(`SELECT r.*, i.num, i.title, i.thumb, d.tweet_url, d.caption AS dcaption, d.schedule_at${threads ? ', t.url AS thread_url' : ''}
    FROM requests r LEFT JOIN items i ON i.id = r.item_id LEFT JOIN decisions d ON d.item_id = r.item_id AND d.request_id = r.id${threads ? ' LEFT JOIN threads t ON t.request_id = r.id' : ''}
    WHERE r.status != 'canceled' ORDER BY r.created_at DESC LIMIT 80`).all();
  const firstItems = await itemsById(env, results.filter(r => r.kind === 'thread').map(r => ((parse(r.payload) || {}).parts || []).find(p => p.itemId)?.itemId));
  return results.map(r => { const payload = parse(r.payload) || {}, first = r.kind === 'thread' && firstItems[(payload.parts || []).find(p => p.itemId)?.itemId], thumb = first ? first.thumb : r.thumb;
    return {id: r.id, kind: r.kind, status: r.status, result: r.result, itemId: r.item_id, num: r.num, title: r.title,
    thumb: thumb && '/m/' + thumb, payload, runAt: r.run_at, url: r.tweet_url || r.thread_url || null, created: r.created_at, updated: r.updated_at}; });
}

// Post hold: on unless you switch it off in the Activity sheet. The agent applies it (agent/post-hold.mjs).
async function postHoldOn(env) {
  const row = await env.DB.prepare(`SELECT v FROM kv WHERE k = 'post_hold'`).first();
  return row ? parse(row.v) !== false : true;
}
// Gap in minutes, tunable from the Activity sheet. 30 until you pick another.
const HOLD_MIN_DEFAULT = 30, HOLD_MIN_RANGE = [5, 240];
async function postHoldMin(env) {
  const row = await env.DB.prepare(`SELECT v FROM kv WHERE k = 'post_hold_min'`).first();
  const v = row ? Number(parse(row.v)) : NaN;
  return Number.isFinite(v) && v >= HOLD_MIN_RANGE[0] && v <= HOLD_MIN_RANGE[1] ? v : HOLD_MIN_DEFAULT;
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

// "Post now" waits this long before the agent can claim it, so an undo is instant and nothing has touched X yet.
const POST_HOLD_MS = 30000;
const holdUntil = () => new Date(Date.now() + POST_HOLD_MS).toISOString();
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
      const c = await requestAction(env, {id: d.request_id, action: 'cancel'});
      if (!c.ok) return c;
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
    if (caption.length > capMax(env)) return bad('caption too long');
    let at = null;
    if (b.scheduleAt) { const d = new Date(b.scheduleAt); if (isNaN(d)) return bad('bad schedule time'); if (tooFar(d)) return bad('that time is more than 60 days out, check the year'); at = d.toISOString(); }
    // The phone retries a POST after a network drop; if the first try landed, hand back that request instead of queueing a second post.
    const prev = await env.DB.prepare(`SELECT d.request_id, d.caption, d.schedule_at, r.status FROM decisions d JOIN requests r ON r.id = d.request_id WHERE d.item_id = ?`).bind(item.id).first();
    if (prev && prev.caption === caption && (prev.schedule_at || null) === at && ['queued', 'claimed', 'posting', 'done'].includes(prev.status)) return json({ok: true, requestId: prev.request_id, duplicate: true});
    // quote post: the app sends quoteUrl (a link you can change or clear in the post sheet); anything that isn't an X post link is refused
    const qRaw = String(b.quoteUrl || '').trim(), qUrl = qRaw ? quoteUrl(qRaw) : null;
    if (qRaw && !qUrl) return bad('the quote link must be an X post link');
    const rid = await newRequest(env, 'post', item.id, {caption, media: item.media, num: item.num, title: item.title, ...(qUrl ? {quoteUrl: qUrl} : {})}, at || holdUntil());
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
    // Undo works at every stage of a post: the agent polls while posting and kills the run as soon as this status changes.
    const isPost = r.kind === 'post' || r.kind === 'thread', inFlight = ['queued', 'claimed', 'posting'].includes(r.status);
    if (!(isPost ? inFlight || r.status === 'failed' : r.status === 'queued')) return bad(r.status === 'posted' ? 'already posted' : 'already started', 409);
    if (r.kind === 'thread') { // a partly posted thread can't go back to a draft, or the draft would repost what is already up. Stop the rest; Retry finishes it.
      const th = await env.DB.prepare(`SELECT parts FROM threads WHERE request_id = ?`).bind(r.id).first();
      const ps = parse(th?.parts) || [], up = ps.filter(p => p.url).length;
      if (up) {
        if (!inFlight) return bad('part of this thread is already on X, use Retry to finish it', 409);
        const msg = `Stopped by you: ${up} of ${ps.length} posts are up. Retry finishes the rest.`;
        await env.DB.batch([env.DB.prepare(`UPDATE requests SET status = 'failed', result = ?, updated_at = ? WHERE id = ?`).bind(msg, t, r.id),
          env.DB.prepare(`UPDATE decisions SET status = 'failed', error = ?, updated_at = ? WHERE request_id = ? AND status != 'posted'`).bind(msg, t, r.id),
          env.DB.prepare(`UPDATE threads SET status = 'failed', updated_at = ? WHERE request_id = ?`).bind(t, r.id)]);
        return json({ok: true, stopped: true, up, of: ps.length});
      }
    }
    const u = await env.DB.prepare(`UPDATE requests SET status = 'canceled', updated_at = ? WHERE id = ? AND status = ?`).bind(t, r.id, r.status).run();
    if (!u.meta.changes) return bad('its status just changed, try again', 409);
    if (r.kind === 'post') { const c = String((parse(r.payload) || {}).caption || ''); if (c && r.item_id) await env.DB.prepare(`UPDATE items SET caption = ? WHERE id = ?`).bind(c, r.item_id).run(); } // keep the text you wrote
    if (r.item_id) await env.DB.prepare(`DELETE FROM decisions WHERE item_id = ? AND request_id = ?`).bind(r.item_id, r.id).run();
    if (r.kind === 'thread') await env.DB.batch([env.DB.prepare(`DELETE FROM decisions WHERE request_id = ?`).bind(r.id), env.DB.prepare(`UPDATE threads SET status = 'draft', request_id = NULL, updated_at = ? WHERE request_id = ?`).bind(t, r.id)]);
    return json({ok: true});
  }
  if (b.action === 'retry') {
    if (r.status !== 'failed') return bad('only failed requests can be retried', 409);
    await env.DB.prepare(`UPDATE requests SET status = 'queued', result = NULL, run_at = ?, updated_at = ? WHERE id = ?`).bind(t, t, r.id).run();
    if (r.kind === 'post' || r.kind === 'thread') await env.DB.prepare(`UPDATE decisions SET status = 'queued', error = NULL, updated_at = ? WHERE request_id = ? AND status != 'posted'`).bind(t, r.id).run();
    if (r.kind === 'thread') await env.DB.prepare(`UPDATE threads SET status = 'queued', updated_at = ? WHERE request_id = ?`).bind(t, r.id).run();
    return json({ok: true});
  }
  if (b.action === 'reschedule' && (r.kind === 'post' || r.kind === 'thread')) {
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
// A post link on X, trimmed to https://x.com/<user>/status/<id>; null for anything else.
const quoteUrl = u => (String(u || '').trim().match(/^https:\/\/(?:x|twitter)\.com\/\w+\/status\/\d+/) || [null])[0];
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
    // Quote posts: the agent sends `quote` only for pieces whose meta has one ({url, handle, name, text}, or null to clear).
    // Kept in kv (k = 'quote:<item id>') so no migration is needed; written whether or not the render version changed.
    for (const x of chunk) if (x.quote !== undefined) {
      const q = x.quote && quoteUrl(x.quote.url) ? {url: quoteUrl(x.quote.url), handle: String(x.quote.handle || '').slice(0, 60), name: String(x.quote.name || '').slice(0, 120), text: String(x.quote.text || '').slice(0, 1200)} : null;
      st.push(q ? env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v, at) VALUES (?, ?, ?)`).bind('quote:' + x.id, JSON.stringify(q), t) : env.DB.prepare(`DELETE FROM kv WHERE k = ?`).bind('quote:' + x.id));
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
  // Your undo wins: a late report from a run you stopped can't change the request or put a draft back in flight. The one exception is a post that
  // had already gone out when you hit undo, which has to be recorded as posted.
  if (r.status === 'canceled' && status !== 'posted') return json({ok: true, ignored: true});
  if (r.status === 'failed' && ['claimed', 'posting'].includes(status)) return json({ok: true, ignored: true});
  await env.DB.prepare(`UPDATE requests SET status = ?, result = COALESCE(?, result), attempts = attempts + ?, updated_at = ? WHERE id = ?`)
    .bind(status, b.result ?? null, status === 'failed' ? 1 : 0, t, r.id).run();
  if (r.kind === 'thread') {
    const ds = {posting: 'posting', posted: 'posted', done: 'posted', failed: 'failed', queued: 'queued', claimed: 'posting'}[status];
    if (ds) await env.DB.prepare(`UPDATE decisions SET status = ?, error = ?, updated_at = ? WHERE request_id = ? AND status != 'posted'`).bind(ds, status === 'failed' ? (b.result ?? 'failed') : null, t, r.id).run();
    const ts = {posting: 'posting', claimed: 'posting', posted: 'posted', done: 'posted', failed: 'failed', queued: 'queued'}[status];
    if (ts) await env.DB.prepare(`UPDATE threads SET status = ?, url = COALESCE(url, ?), updated_at = ? WHERE request_id = ?`).bind(ts, b.url ?? null, t, r.id).run();
  }
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
        if (p === '/api/agent/settings' && m === 'GET') return json({postHold: await postHoldOn(env), postHoldMin: await postHoldMin(env)});
        if (p === '/api/agent/scheduled' && m === 'GET') {
          const {results} = await env.DB.prepare(`SELECT r.id, r.item_id, r.run_at, r.payload, i.num, i.title FROM requests r LEFT JOIN items i ON i.id = r.item_id
            WHERE r.kind IN ('post', 'thread') AND r.status = 'queued' AND r.run_at > ? ORDER BY r.run_at`).bind(now()).all();
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
        if (p.startsWith('/api/agent/request/') && m === 'GET') { const r = await env.DB.prepare(`SELECT id, status FROM requests WHERE id = ?`).bind(decodeURIComponent(p.slice('/api/agent/request/'.length))).first(); return r ? json(r) : bad('unknown request', 404); }
        if (p === '/api/agent/cancel' && m === 'POST') { const b = await body(request); return requestAction(env, {id: b.id, action: 'cancel'}); }
        if (p === '/api/agent/thread' && m === 'POST') return agentThread(env, await body(request, 512 * 1024));
        if (p === '/api/agent/thread-split' && m === 'POST') return agentThreadSplit(env, await body(request));
        if (p === '/api/agent/thread-part' && m === 'POST') return agentThreadPart(env, await body(request));
        if (p.startsWith('/api/agent/thread/') && m === 'GET') { const t = await threadRow(env, decodeURIComponent(p.slice('/api/agent/thread/'.length))); return t ? json({thread: await threadOut(env, t)}) : bad('unknown thread', 404); }
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
        if (p === '/api/settings' && m === 'POST') {
          const b = await body(request);
          if (b.postHold === undefined && b.postHoldMin === undefined) return bad('postHold or postHoldMin required');
          if (b.postHold !== undefined && typeof b.postHold !== 'boolean') return bad('postHold must be true or false');
          if (b.postHoldMin !== undefined && !(Number.isInteger(b.postHoldMin) && b.postHoldMin >= HOLD_MIN_RANGE[0] && b.postHoldMin <= HOLD_MIN_RANGE[1])) return bad(`postHoldMin must be a whole number from ${HOLD_MIN_RANGE[0]} to ${HOLD_MIN_RANGE[1]}`);
          if (b.postHold !== undefined) await env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v, at) VALUES ('post_hold', ?, ?)`).bind(JSON.stringify(b.postHold), now()).run();
          if (b.postHoldMin !== undefined) await env.DB.prepare(`INSERT OR REPLACE INTO kv (k, v, at) VALUES ('post_hold_min', ?, ?)`).bind(JSON.stringify(b.postHoldMin), now()).run();
          return json({ok: true, postHold: await postHoldOn(env), postHoldMin: await postHoldMin(env)});
        }
        if (p === '/api/feed' && m === 'GET') {
          const [items, agent, open] = await Promise.all([feed(env), agentSeen(env),
            env.DB.prepare(`SELECT COUNT(*) AS n, SUM(status = 'failed') AS f FROM requests WHERE status NOT IN ('done', 'posted', 'canceled')`).first()]);
          return json({items, agent, open: open?.n || 0, failed: open?.f || 0, postHold: await postHoldOn(env), postHoldMin: await postHoldMin(env), captionMax: capMax(env)});
        }
        // Cheap change check the open app polls every few seconds; it fetches /api/feed only when feed changes.
        if (p === '/api/pulse' && m === 'GET') {
          const later = (await hasLaterCols(env)) ? `, MAX(i.deferred_at) AS da, MAX(i.restored_at) AS ra` : '';
          const threads = await hasThreads(env);
          const [f, r, agent, th] = await Promise.all([
            env.DB.prepare(`SELECT COUNT(*) AS n, MAX(i.version) AS v, MAX(i.updated_at) AS u${later} FROM items i LEFT JOIN decisions d ON d.item_id = i.id WHERE d.item_id IS NULL AND i.media IS NOT NULL`).first(),
            env.DB.prepare(`SELECT COUNT(*) AS n, MAX(updated_at) AS u, SUM(status NOT IN ('done', 'posted', 'canceled')) AS o, SUM(status = 'failed' AND status NOT IN ('done', 'posted', 'canceled')) AS x FROM requests`).first(),
            agentSeen(env),
            threads ? env.DB.prepare(`SELECT COUNT(*) AS n, MAX(version) AS v, MAX(updated_at) AS u FROM threads WHERE status = 'draft'`).first() : {}]);
          return json({feed: [f.n, f.v, f.u, f.da, f.ra, th.n, th.v, th.u].join('|'), reqs: [r.n, r.u].join('|'), agent, open: r.o || 0, failed: r.x || 0});
        }
        if (p === '/api/activity' && m === 'GET') return json({requests: await activity(env), agent: await agentSeen(env)});
        if (p === '/api/decide' && m === 'POST') return decide(env, await body(request));
        if (p === '/api/defer' && m === 'POST') return defer(env, await body(request));
        if (p === '/api/thread' && m === 'POST') return threadAction(env, await body(request, 512 * 1024));
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
