// Push every finished piece in PIECES_DIR and its media to the feed. Safe to run any time: unchanged media is skipped.
// A piece is a folder with meta.json: {title, caption, alts, numbers, source, kind: "video"|"still", aspect, media: "output/video.mp4"}.
// Optional "quote": {url, handle, name, text} makes the piece post as a quote of that X post; "quote": null clears it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { api, log, PIECES } from './lib.mjs';
const safe = s => String(s).replace(/[^\w.\-]/g, '_');
const TYPES = {mp4: 'video/mp4', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp'};
function thumbOf(media, kind) {
  if (kind !== 'video') return fs.readFileSync(media);
  const f = path.join(os.tmpdir(), `feed-thumb-${process.pid}.jpg`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', '1', '-i', media, '-frames:v', '1', '-vf', 'scale=540:-2', f]);
  const b = fs.readFileSync(f); fs.rmSync(f); return b;
}
export async function sync({quiet} = {}) {
  const have = new Set((await api('/api/agent/media-keys')).keys);
  const out = []; let uploaded = 0;
  for (const id of fs.existsSync(PIECES) ? fs.readdirSync(PIECES) : []) {
    const dir = path.join(PIECES, id), metaFile = path.join(dir, 'meta.json');
    if (!fs.existsSync(metaFile)) continue;
    let m; try { m = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (e) { log('bad meta', id, e.message); continue; }
    const media = m.media && path.join(dir, m.media);
    if (!media || !fs.existsSync(media) || !m.caption) continue;
    const st = fs.statSync(media), mediaVersion = Math.round(st.mtimeMs / 1000), ext = media.split('.').pop().toLowerCase();
    const version = Math.max(mediaVersion, Math.round(fs.statSync(metaFile).mtimeMs / 1000)); // a caption edit is a new version too
    const kind = m.kind === 'video' ? 'video' : 'still', base = `${safe(id)}-${mediaVersion}`, mk = `m/${base}.${ext}`, tk = `t/${base}.${kind === 'video' ? 'jpg' : ext}`;
    if (!have.has(mk)) { await api('/api/agent/media/' + mk, {method: 'PUT', raw: fs.readFileSync(media), headers: {'content-type': TYPES[ext] || 'application/octet-stream'}, timeout: 180000}); uploaded++; }
    if (!have.has(tk)) { await api('/api/agent/media/' + tk, {method: 'PUT', raw: thumbOf(media, kind), headers: {'content-type': kind === 'video' ? 'image/jpeg' : TYPES[ext] || 'image/jpeg'}}); uploaded++; }
    const quote = m.quote === undefined ? undefined : m.quote && m.quote.url ? {url: m.quote.url, handle: m.quote.handle || '', name: m.quote.name || '', text: String(m.quote.text || '').slice(0, 1200)} : null;
    out.push({id, num: m.num ?? null, batch: m.batch ?? null, title: m.title || '', caption: m.caption, alts: m.alts || [], numbers: m.numbers || '', source: m.source || '', kind, aspect: m.aspect || null, media: mk, thumb: tk, version, created: m.created || new Date(st.mtimeMs).toISOString(), handled: null, tweetUrl: null, ...(quote !== undefined ? {quote} : {})});
  }
  let added = 0, updated = 0;
  for (let k = 0; k < out.length; k += 60) { const r = await api('/api/agent/items', {method: 'POST', body: {items: out.slice(k, k + 60)}}); added += r.added; updated += r.updated; }
  const res = {items: out.length, added, updated, uploaded};
  if (!quiet || added || updated || uploaded) log('sync', res);
  return res;
}
if (import.meta.url === `file://${process.argv[1]}`) sync().then(r => console.log(JSON.stringify(r))).catch(e => { console.error('sync failed:', e.message); process.exit(1); });
