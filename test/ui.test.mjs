// Headless browser checks of the app: grid view, arrow keys, quote field, wide layout and the post hold controls against a mocked API,
// then the Make a thread sheet and the thread editor against the built Worker on the in-memory D1 shim. No window opens and nothing is posted.
// Needs Playwright:  npm i -D playwright  (or set PLAYWRIGHT=/path/to/playwright/index.mjs), then  node test/ui.test.mjs
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { ROOT, OWNER, makeEnv, loadWorker, checker } from './d1-shim.mjs';
let pw;
try { pw = await import(process.env.PLAYWRIGHT || 'playwright'); } catch { console.log('Playwright not found. Install it or set PLAYWRIGHT=/path/to/playwright/index.mjs'); process.exit(2); }
const { chromium, devices } = pw.chromium ? pw : pw.default;
const html = fs.readFileSync(path.join(ROOT, 'site/worker/app.html'), 'utf8');
const {ok, done} = checker();
const img = (w, h, c) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="100%" height="100%" fill="${c}"/></svg>`)}`;
const mk = (n, o = {}) => ({id: 'i' + n, num: n, version: 1, title: 'Piece ' + n, caption: `Caption for piece ${n}.\n\nSecond paragraph with a few more words so the clamp has something to do in a narrow tile.`, kind: 'image', aspect: n % 3 ? 1 : 0.72, media: img(800, 800, ['#345', '#543', '#354', '#445'][n % 4]), thumb: img(200, 200, '#333'), alts: ['Alt caption ' + n], batch: n < 14 ? 'b1' : 'b2', deferred: null, edited: n === 10, ...o});
const QUOTE = {url: 'https://x.com/someone/status/123', handle: 'someone', name: 'Some One', text: 'The words being quoted'};
function server() {
  const state = {items: [17, 16, 15, 14, 13, 12, 11, 10, 9, 8].map(n => mk(n)), calls: [], sig: 1, postHold: true, postHoldMin: 30};
  state.items.push({id: 'thread:th1', thread: true, threadId: 'th1', title: 'A thread', version: 1, deferred: null, status: 'draft', parts: [{itemId: 'x1', text: 'Thread lead text', num: 1, kind: 'image', aspect: 1, media: img(800, 800, '#633'), thumb: img(200, 200, '#633')}, {itemId: null, text: 'second'}]});
  return state;
}
async function open(browser, ctxOpts, state) {
  const ctx = await browser.newContext(ctxOpts), p = await ctx.newPage(), errs = [];
  p.on('pageerror', e => errs.push(String(e))); p.on('console', m => m.type() === 'error' && !/favicon|manifest/.test(m.text()) && errs.push(m.text()));
  await p.route('**/*', async r => {
    const u = new URL(r.request().url()), body = r.request().postDataJSON?.() ?? null;
    const json = o => r.fulfill({contentType: 'application/json', body: JSON.stringify(o)});
    if (u.pathname === '/') return r.fulfill({contentType: 'text/html', body: html});
    if (u.pathname === '/api/feed') return json({items: state.items, agent: {at: new Date().toISOString()}, open: 0, failed: 0, postHold: state.postHold, postHoldMin: state.postHoldMin, captionMax: state.captionMax || 25000});
    if (u.pathname === '/api/pulse') return json({feed: state.sig, reqs: 1, agent: {at: new Date().toISOString()}, open: 0, failed: 0});
    if (u.pathname === '/api/activity') return json({requests: state.activity || [], agent: {at: new Date().toISOString()}});
    if (u.pathname.startsWith('/api/')) {
      state.calls.push([u.pathname, body]);
      if (u.pathname === '/api/decide' && body.action !== 'undo') { state.items = state.items.filter(x => x.id !== body.id); state.sig++; }
      if (u.pathname === '/api/defer') { const it = state.items.find(x => x.id === body.id); state.items = state.items.filter(x => x !== it); it.deferred = new Date().toISOString(); state.items.push(it); state.sig++; return json({deferred: it.deferred}); }
      if (u.pathname === '/api/reorder') { const ts = state.activity.map(x => x.runAt).sort(); body.ids.forEach((id, i) => { state.activity.find(x => x.id === id).runAt = ts[i]; }); return json({ok: true}); }
      if (u.pathname === '/api/settings') { Object.assign(state, body); return json({ok: true, postHold: state.postHold, postHoldMin: state.postHoldMin}); }
      return json({ok: true});
    }
    return r.fulfill({status: 404, body: ''});
  });
  await p.goto('http://feed.test/'); await p.waitForTimeout(500);
  return {p, errs, ctx};
}
const DESKTOP = {viewport: {width: 1440, height: 900}}, PHONE = {...devices['iPhone 14']};
const b = await chromium.launch(); // headless

// ---- grid view (desktop) ----
{
  const st = server(), {p, errs} = await open(b, DESKTOP, st);
  const tiles = () => p.locator('#grid .tile').count(), ids = () => p.$$eval('#grid .tile', ts => ts.map(t => t._it.id));
  ok(await p.locator('#bView').isVisible(), 'desktop: grid button is shown');
  ok(await p.locator('.card').count() > 0 && await tiles() === 0, 'desktop: starts in the one-card view');
  await p.click('#bView'); await p.waitForTimeout(200);
  ok(await tiles() === 11 && await p.locator('.card').count() === 0, 'grid: 11 tiles, no card');
  ok(!(await p.locator('footer').isVisible()), 'grid: bottom action bar hidden');
  await p.locator('#grid .tile').nth(3).locator('[data-a=skip]').click(); await p.waitForTimeout(450);
  ok(st.calls.at(-1)[0] === '/api/decide' && st.calls.at(-1)[1].id === 'i14' && st.calls.at(-1)[1].action === 'pass', 'grid skip: the right item was skipped');
  ok(await tiles() === 10 && !(await ids()).includes('i14'), 'grid skip: tile is gone');
  ok(await p.locator('#toast.on').isVisible(), 'grid skip: Undo toast shown');
  const before = await ids();
  await p.locator('#grid .tile').nth(4).locator('[data-a=post]').click(); await p.waitForTimeout(350);
  ok((await p.inputValue('#pCap')).startsWith('Caption for piece 12'), 'grid post: sheet shows that tile\'s caption');
  await p.click('#shPost [data-close]'); await p.waitForTimeout(300);
  ok(JSON.stringify(await ids()) === JSON.stringify(before), 'grid post cancelled: order unchanged');
  await p.locator('#grid .tile').nth(4).locator('[data-a=post]').click(); await p.waitForTimeout(350);
  await p.click('#pGo'); await p.waitForTimeout(500);
  ok(st.calls.at(-1)[1].id === 'i12' && st.calls.at(-1)[1].action === 'post', 'grid post: posted that tile');
  ok(await tiles() === 9, 'grid post: tile gone');
  await p.locator('#grid .tile').nth(0).locator('[data-a=later]').click(); await p.waitForTimeout(600);
  ok((await ids()).at(-1) === 'i17' && st.calls.at(-1)[0] === '/api/defer', 'grid later: tile moved to the end');
  ok(await p.locator('#grid .tile').last().locator('.tag', {hasText: 'Later'}).count() === 1, 'grid later: tile shows the Later tag');
  await p.locator('#grid .tile').nth(1).locator('[data-a=edit]').click(); await p.waitForTimeout(400);
  await p.fill('#eTxt', 'make it bigger'); await p.click('#eGo'); await p.waitForTimeout(500);
  ok(st.calls.at(-1)[1].action === 'edit' && st.calls.at(-1)[1].id === 'i15' && st.calls.at(-1)[1].note === 'make it bigger', 'grid edit: note sent for that tile');
  await p.locator('#grid .tile').nth(2).locator('.tmed').click(); await p.waitForTimeout(350);
  ok(await p.locator('.card:not(.back)').count() === 1 && await tiles() === 0 && await p.locator('#bBack').isVisible(), 'open big: one card, Back to grid shown');
  await p.keyboard.press('Escape'); await p.waitForTimeout(300);
  ok(await tiles() === 8, 'Escape: back to the grid');
  await p.locator('#grid .tile').nth(2).locator('.tmed').click(); await p.waitForTimeout(350);
  await p.click('#fNo'); await p.waitForTimeout(600);
  ok(await tiles() === 7 && st.calls.at(-1)[1].action === 'pass', 'open big then skip: back in the grid');
  await p.locator('#grid .tile', {hasText: 'Thread lead text'}).locator('[data-a=post]').click(); await p.waitForTimeout(400);
  ok(await p.locator('#shThread.on').count() === 1, 'thread tile: Post opens the thread editor');
  await p.click('#tClose'); await p.waitForTimeout(400);
  st.items.unshift(mk(18)); st.sig++; await p.waitForTimeout(3600);
  ok((await ids())[0] === 'i18' && await tiles() === 8, 'live update: new piece appears first in the grid');
  await p.reload(); await p.waitForTimeout(600);
  ok(await tiles() === 8, 'reload: still in grid view');
  await p.click('#bView'); await p.waitForTimeout(250);
  ok(await tiles() === 0 && await p.locator('.card:not(.back)').count() === 1 && await p.locator('footer').isVisible(), 'toggle off: one-card view and action bar back');
  await p.click('#bView'); await p.waitForTimeout(200);
  await p.setViewportSize({width: 700, height: 900}); await p.waitForTimeout(300);
  ok(await tiles() === 0 && await p.locator('.card:not(.back)').count() === 1 && !(await p.locator('#bView').isVisible()), 'narrow window: one card, button hidden');
  ok(errs.length === 0, 'grid: no page errors ' + JSON.stringify(errs).slice(0, 300));
  await p.close();
}
// ---- phone: no grid ----
{
  const st = server(), {p, errs} = await open(b, PHONE, st);
  await p.evaluate(() => localStorage.setItem('feed.view', 'grid')); await p.reload(); await p.waitForTimeout(600);
  ok(!(await p.locator('#bView').isVisible()) && await p.locator('#grid .tile').count() === 0 && await p.locator('.card:not(.back)').count() === 1, 'phone: no grid button, one-card view even with the grid preference saved');
  await p.click('#fNo'); await p.waitForTimeout(600);
  ok(st.calls.at(-1)[1].action === 'pass' && st.calls.at(-1)[1].id === 'i17', 'phone: skip works on the front card');
  ok(!(await p.locator('.khint').isVisible()), 'phone: no arrow-key hint');
  ok(errs.length === 0, 'phone: no page errors ' + JSON.stringify(errs).slice(0, 300));
  await p.close();
}
// ---- arrow keys (desktop) ----
{
  const st = server(), {p, errs} = await open(b, DESKTOP, st);
  await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(500);
  ok(st.calls.at(-1)[0] === '/api/decide' && st.calls.at(-1)[1].id === 'i17' && st.calls.at(-1)[1].action === 'pass', 'Left: skips the front card');
  await p.keyboard.press('ArrowUp'); await p.waitForTimeout(600);
  ok(st.calls.at(-1)[0] === '/api/defer' && st.calls.at(-1)[1].id === 'i16', 'Up: sends the card to the back');
  await p.keyboard.press('ArrowRight'); await p.waitForTimeout(400);
  ok(await p.locator('#shPost.on').isVisible() && (await p.inputValue('#pCap')).startsWith('Caption for piece 15'), 'Right: post sheet opens');
  const n0 = st.calls.length;
  await p.keyboard.press('ArrowLeft'); await p.keyboard.press('ArrowDown'); await p.waitForTimeout(300);
  ok(st.calls.length === n0 && await p.locator('#shPost.on').isVisible(), 'keys ignored while a sheet is open');
  await p.click('#shPost [data-close]'); await p.waitForTimeout(350);
  await p.keyboard.press('ArrowDown'); await p.waitForTimeout(450);
  ok(await p.locator('#shEdit.on').isVisible(), 'Down: edit sheet opens');
  await p.keyboard.type('bigger');
  ok((await p.inputValue('#eTxt')) === 'bigger', 'typing goes into the edit box');
  await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(200);
  ok(st.calls.length === n0, 'Left while typing does nothing');
  await p.click('#eGo'); await p.waitForTimeout(500);
  ok(st.calls.at(-1)[1].action === 'edit' && st.calls.at(-1)[1].id === 'i15', 'edit sent for that card');
  await p.keyboard.down('Meta'); await p.keyboard.press('ArrowLeft'); await p.keyboard.up('Meta'); await p.waitForTimeout(300);
  ok(st.calls.at(-1)[1].action === 'edit', 'Cmd+Left is not a hotkey');
  await p.click('#bView'); await p.waitForTimeout(250);
  const ids = () => p.$$eval('#grid .tile', ts => ts.map(t => t._it.id)), first = (await ids())[0];
  await p.mouse.move(5, 5); await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(450);
  ok(st.calls.at(-1)[1].id === first && st.calls.at(-1)[1].action === 'pass', 'grid, no hover: Left skips the first tile');
  const want = (await ids())[2];
  await p.locator('#grid .tile').nth(2).hover(); await p.keyboard.press('ArrowLeft'); await p.waitForTimeout(450);
  ok(st.calls.at(-1)[1].action === 'pass' && st.calls.at(-1)[1].id === want, 'grid hover: Left skips the hovered tile');
  await p.locator('#grid .tile').nth(1).hover(); await p.keyboard.press('ArrowRight'); await p.waitForTimeout(400);
  ok(await p.locator('#shPost.on').isVisible(), 'grid hover: Right opens the post sheet');
  await p.click('#shPost [data-close]'); await p.waitForTimeout(300);
  ok((await p.locator('#fNo').getAttribute('title')) === 'Skip (←)', 'tooltip shows the key');
  ok(errs.length === 0, 'keys: no page errors ' + errs.join(' | '));
  await p.close();
}
// ---- quote field (phone and desktop) ----
for (const [name, opts] of [['phone', PHONE], ['desktop', DESKTOP]]) {
  const st = server(); st.items[0].quote = QUOTE;
  const {p, errs} = await open(b, opts, st);
  ok(await p.locator('.card:not(.back) .tag', {hasText: 'Quotes @someone'}).count() === 1, name + ': card shows the quote tag');
  await p.click('#fGo'); await p.waitForTimeout(400);
  ok(await p.inputValue('#pQuote') === QUOTE.url, name + ': link prefilled');
  ok(await p.locator('#pQPrev').isVisible() && (await p.locator('#pQPrev').innerText()).includes('The words being quoted'), name + ': quoted text previewed');
  ok((await p.locator('#pGo').innerText()) === 'Quote post now', name + ': button says Quote post now');
  await p.fill('#pQuote', 'not a link'); await p.waitForTimeout(100);
  ok(await p.locator('#pGo').isDisabled(), name + ': a bad link disables posting');
  await p.fill('#pQuote', ''); await p.waitForTimeout(100);
  ok((await p.locator('#pGo').innerText()) === 'Post now' && !(await p.locator('#pQPrev').isVisible()), name + ': a cleared link is a normal post');
  await p.fill('#pQuote', QUOTE.url); await p.waitForTimeout(100);
  await p.click('#pGo'); await p.waitForTimeout(500);
  const c = st.calls.find(x => x[0] === '/api/decide');
  ok(c && c[1].quoteUrl === QUOTE.url && c[1].action === 'post', name + ': decide carries quoteUrl');
  ok(errs.length === 0, name + ': no page errors ' + errs.join('|'));
  await p.close();
}
{
  const st = server(), {p} = await open(b, DESKTOP, st); await p.click('#fGo'); await p.waitForTimeout(400);
  ok(await p.inputValue('#pQuote') === '' && (await p.locator('#pGo').innerText()) === 'Post now', 'no quote: empty field, Post now');
  await p.fill('#pQuote', 'https://x.com/a/status/9'); await p.click('#pGo'); await p.waitForTimeout(500);
  ok(st.calls.find(x => x[0] === '/api/decide')[1].quoteUrl === 'https://x.com/a/status/9', 'no quote: a pasted link is sent');
  await p.close();
}
// ---- caption length: count past 280, block past the limit ----
{
  const st = server(), {p} = await open(b, PHONE, st); await p.click('#fGo'); await p.waitForTimeout(400);
  await p.fill('#pCap', 'x'.repeat(449)); await p.waitForTimeout(100);
  ok((await p.locator('#pCount').innerText()) === '449 chars' && !(await p.locator('#pGo').isDisabled()), '449 characters: counted, still postable');
  await p.fill('#pCap', 'x'.repeat(25001)); await p.waitForTimeout(100);
  ok(await p.locator('#pGo').isDisabled(), '25,001 characters: blocked');
  await p.close();
  const s2 = server(); s2.captionMax = 280; const r2 = await open(b, PHONE, s2); await r2.p.click('#fGo'); await r2.p.waitForTimeout(400);
  await r2.p.fill('#pCap', 'x'.repeat(281)); await r2.p.waitForTimeout(100);
  ok(await r2.p.locator('#pGo').isDisabled(), 'CAPTION_MAX=280: 281 characters blocked');
  await r2.p.close();
}
// ---- wide layout ----
for (const [name, opts] of [['wide', {viewport: {width: 1920, height: 1080}}], ['phone', PHONE]]) {
  const st = server(); st.items[0].caption = 'A long caption that would otherwise run in one line all the way across a very wide desktop window, far from the picture it describes. '.repeat(2);
  const {p, errs} = await open(b, opts, st);
  const r = await p.evaluate(() => { const c = document.querySelector('.card:not(.back)'), cap = c.querySelector('.cap').getBoundingClientRect(), cr = c.getBoundingClientRect(), m = c.querySelector('.meta').getBoundingClientRect(); return {cw: cr.width, capw: cap.width, capMid: cap.left + cap.width / 2, cardMid: cr.left + cr.width / 2, metaL: m.left, capL: cap.left}; });
  if (name === 'wide') { ok(r.capw <= 721 && Math.abs(r.capMid - r.cardMid) < 2, `wide: caption is a centred column of ${Math.round(r.capw)}px in a ${Math.round(r.cw)}px card`); ok(Math.abs(r.metaL - r.capL) < 2, 'wide: meta line starts under the caption'); }
  else ok(r.capw > 300 && r.capw > r.cw - 60, `phone: caption is full width (${Math.round(r.capw)} of ${Math.round(r.cw)})`);
  ok(errs.length === 0, name + ': no page errors');
  await p.close();
}
// ---- activity: waiting posts sort by time and drag into a new order (phone, touch) ----
{
  const st = server(), at = m => new Date(Date.now() + m * 60000).toISOString();
  st.activity = [['r3', 190], ['r1', 70], ['r2', 130]].map(([id, m]) => ({id, kind: 'post', status: 'queued', payload: {caption: 'post ' + id}, runAt: at(m), created: at(-5), updated: at(-5)}));
  const {p, errs} = await open(b, PHONE, st);
  await p.click('#bAct'); await p.waitForTimeout(500);
  const order = () => p.evaluate(() => [...document.querySelectorAll('#actList .row[data-rid]')].map(x => x.dataset.rid).join());
  ok(await order() === 'r1,r2,r3', 'activity: waiting posts list the next one first');
  const h = await p.locator('.row[data-rid="r3"] .hdl').boundingBox(), top = await p.locator('.row[data-rid="r1"]').boundingBox();
  const cdp = await p.context().newCDPSession(p), pt = (type, y) => cdp.send('Input.dispatchTouchEvent', {type, touchPoints: type === 'touchEnd' ? [] : [{x: h.x + h.width / 2, y}]});
  await pt('touchStart', h.y + h.height / 2);
  for (let i = 1; i <= 10; i++) await pt('touchMove', h.y + h.height / 2 + (top.y - 6 - h.y) * i / 10);
  await pt('touchEnd'); await p.waitForTimeout(500);
  const call = st.calls.find(c => c[0] === '/api/reorder');
  ok(call && call[1].ids.join() === 'r3,r1,r2', 'drag: the last post dragged to the top sends the new order');
  ok(await order() === 'r3,r1,r2' && /post r3/.test(await p.locator('#actList .row[data-rid]').first().innerText()), 'drag: the list shows the new order, same times');
  ok(errs.length === 0, 'drag: no page errors ' + errs.join('|'));
  await p.close();
}
// ---- post hold switch and gap stepper (phone) ----
{
  const st = server(), {p, errs} = await open(b, PHONE, st);
  await p.click('#bAct'); await p.waitForTimeout(500);
  ok((await p.locator('#holdSw').innerText()) === 'On' && (await p.locator('#holdMin').innerText()) === '30 min', 'activity: hold is On at 30 min');
  await p.click('#holdMinus'); await p.click('#holdMinus'); await p.waitForTimeout(1100);
  const saves = st.calls.filter(c => c[0] === '/api/settings');
  ok((await p.locator('#holdMin').innerText()) === '15 min' && saves.length === 1 && saves[0][1].postHoldMin === 15, 'stepper: 30 to 15 saves once');
  for (let i = 0; i < 8; i++) if (!(await p.locator('#holdPlus').isDisabled())) await p.click('#holdPlus');
  ok((await p.locator('#holdMin').innerText()) === '2 h' && await p.locator('#holdPlus').isDisabled(), 'stepper: stops at 2 h');
  await p.waitForTimeout(1000);
  await p.click('#holdSw'); await p.waitForTimeout(400);
  ok(st.calls.at(-1)[0] === '/api/settings' && st.calls.at(-1)[1].postHold === false && (await p.locator('#holdSw').innerText()) === 'Off', 'switch: turns the hold off');
  ok(errs.length === 0, 'hold: no page errors ' + errs.join('|'));
  await p.close();
}
// ---- threads: the real Worker on the D1 shim, served over a local port ----
{
  const {env} = makeEnv('cloudflare-access'), w = await loadWorker();
  const srv = http.createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const r = await w.fetch(new Request('http://feed.test' + req.url, {method: req.method, headers: {'content-type': 'application/json', 'cf-access-authenticated-user-email': OWNER, ...(req.headers.authorization ? {authorization: req.headers.authorization} : {})}, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body}), env);
    res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
  });
  await new Promise(res => srv.listen(0, '127.0.0.1', res));
  const base = 'http://127.0.0.1:' + srv.address().port;
  await fetch(base + '/api/agent/items', {method: 'POST', headers: {authorization: `Bearer ${env.AGENT_TOKEN}`}, body: JSON.stringify({items: [1, 2, 3, 4].map(n => ({id: 'i' + n, num: n, batch: n < 4 ? 'b1' : 'b2', title: 'T' + n, caption: 'cap ' + n, media: `m/${n}.png`, thumb: `t/${n}.png`, kind: 'still', aspect: 1, version: 1}))})});
  const feed = async () => (await (await fetch(base + '/api/feed')).json()).items;
  for (const [name, opts] of [['phone', PHONE], ['desktop', DESKTOP]]) {
    const ctx = await b.newContext(opts), p = await ctx.newPage(), errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(base + '/'); await p.waitForTimeout(800);
    const make = p.locator('.card:not(.back) .mk');
    ok((await make.innerText()).includes('Make a thread'), name + ': the card offers Make a thread');
    await make.click(); await p.waitForTimeout(400);
    ok(await p.locator('#shMake.on').count() === 1 && await p.locator('#makeList .mkrow').count() === 4, name + ': the sheet lists the feed');
    ok(await p.locator('#makeList input:checked').count() === 1, name + ': this card is ticked');
    await p.locator('#makeList input').nth(2).check(); await p.waitForTimeout(100);
    ok(/2/.test(await p.locator('#makeGo').innerText()), name + ': the button counts the ticked pieces');
    await p.locator('#makeGo').click(); await p.waitForTimeout(800);
    ok(await p.locator('#shThread.on').count() === 1 && await p.locator('#tParts textarea').count() === 2, name + ': the thread editor opens with 2 posts');
    let f = await feed();
    ok(f.filter(x => !x.thread).length === 4 && f.filter(x => x.thread).length === 1 && f.filter(x => x.inThread).length === 2, name + ': pieces stay their own cards and two are tagged');
    await p.locator('#tParts textarea').first().fill('Edited lead ' + name); await p.waitForTimeout(1500);
    ok((await feed()).find(x => x.thread).parts[0].text === 'Edited lead ' + name, name + ': text saves as you type');
    await p.locator('#tSplit').click(); await p.waitForTimeout(700);
    f = await feed();
    ok(f.filter(x => !x.thread).length === 4 && f.filter(x => x.thread).length === 0, name + ': Delete thread leaves the pieces');
    ok(errs.length === 0, name + ' threads: no page errors ' + errs.join('|'));
    await ctx.close();
  }
  srv.close();
}
await b.close();
process.exit(done('ui') ? 1 : 0);
