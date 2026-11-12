#!/usr/bin/env node
// feed: the one CLI an agent needs to get a draft in front of you.
//   feed new <slug> [--batch name]   allocate the next number, make pieces/NNN-slug/ with a blank meta.json
//   feed publish <piece>             check meta.json, then sync to the app (posts nothing)
//   feed thread put <id> <file.json> draft a thread as one card in the app: {title, batch, parts: [{num, text}]}; a part with no num is text only
//   feed thread get <id>             print a drafted thread (your edits in the app included) as that same JSON
import fs from 'node:fs';
import path from 'node:path';
import { PIECES, api } from './lib.mjs';
import { sync } from './sync.mjs';
const die = m => { console.error('feed: ' + m); process.exit(1); };
const all = () => fs.existsSync(PIECES) ? fs.readdirSync(PIECES).filter(d => fs.existsSync(path.join(PIECES, d, 'meta.json'))) : [];
const [cmd, a, b, c] = process.argv.slice(2);
const USAGE = 'usage: feed new <slug> [--batch name] | publish <piece> | thread put <id> <file.json> | thread get <id>';
if (cmd === 'new') {
  if (!a) die('usage: feed new <slug> [--batch name]');
  const n = Math.max(0, ...all().map(d => parseInt(d, 10) || 0)) + 1, name = `${String(n).padStart(3, '0')}-${a}`, dir = path.join(PIECES, name);
  fs.mkdirSync(path.join(dir, 'output'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({num: n, title: '', caption: '', alts: [], numbers: '', source: '', kind: 'video', aspect: 1, media: 'output/video.mp4', batch: b === '--batch' ? c : null, created: new Date().toISOString()}, null, 1));
  console.log(name);
} else if (cmd === 'publish') {
  const name = all().find(d => d === a || parseInt(d, 10) === parseInt(a, 10)) || die(`no piece "${a}"`);
  let m; try { m = JSON.parse(fs.readFileSync(path.join(PIECES, name, 'meta.json'), 'utf8')); } catch (e) { die(e.message); }
  const bad = [];
  if (!m.caption) bad.push('caption is empty');
  if (!m.media || !fs.existsSync(path.join(PIECES, name, m.media))) bad.push(`media missing: ${m.media}`);
  if (bad.length) die(`${name} not published:\n  ${bad.join('\n  ')}`);
  console.log(JSON.stringify(await sync()));
  console.log(`feed: ${name} is in the app`);
} else if (cmd === 'thread') {
  const id = b || die(USAGE);
  if (a === 'get') {
    const {thread: t} = await api('/api/agent/thread/' + encodeURIComponent(id));
    console.log(JSON.stringify({title: t.title, batch: t.batch, status: t.status, parts: t.parts.map(p => ({...(p.num != null ? {num: p.num} : {}), text: p.text, ...(p.url ? {url: p.url} : {})}))}, null, 1));
  } else if (a === 'put') {
    const file = c || die(USAGE); let d;
    try { d = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { die(`${file}: ${e.message}`); }
    if (!Array.isArray(d.parts) || !d.parts.length) die('a thread needs parts: [{num, text}]');
    const bad = d.parts.flatMap((p, i) => !String(p.text || '').trim() && p.num == null ? [`part ${i + 1} is empty`] : []);
    if (bad.length) die(bad.join('\n'));
    await sync(); // so every piece the thread names is in the app first
    const r = await api('/api/agent/thread', {method: 'POST', body: {id, title: d.title, batch: d.batch, parts: d.parts}});
    if (r.skipped?.length) console.log('left out: ' + JSON.stringify(r.skipped));
    console.log(`feed: thread ${id} is in the app as one card, ${r.thread.parts.length} posts`);
  } else die(USAGE);
} else die(USAGE);
