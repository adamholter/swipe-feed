// Worker checks against the in-memory D1 shim, run once per AUTH_MODE: auth, feed, decide, undo, threads, post hold settings, quotes.
// Nothing here touches a network or posts anything.  node test/worker.test.mjs
import { makeEnv, loadWorker, caller, checker, OWNER, TOKEN } from './d1-shim.mjs';
const {ok, done} = checker();
const item = (n, o = {}) => ({id: 'i' + n, num: n, batch: 'b1', title: 'T' + n, caption: 'cap ' + n, media: `m/i${n}.png`, thumb: `t/i${n}.png`, kind: 'still', aspect: 1, version: 1, ...o});
const one = (db, sql, ...a) => db.prepare(sql).get(...a);

for (const mode of ['sites', 'cloudflare-access']) {
  const {db, env} = makeEnv(mode), w = await loadWorker(), call = caller(w, env, mode), T = m => `[${mode}] ${m}`;

  // ---- auth ----
  ok((await call('/api/feed', undefined, {headers: {}})).status === 401, T('feed refused with no identity'));
  ok((await call('/api/settings', {postHold: false}, {headers: {}})).status === 401, T('settings refused with no identity'));
  ok((await call('/api/thread', {action: 'make', itemIds: ['i1']}, {headers: {}})).status === 401, T('thread refused with no identity'));
  const other = mode === 'sites' ? {'oai-authenticated-user-email': 'someone@else.com'} : {'cf-access-authenticated-user-email': 'someone@else.com'};
  ok((await call('/api/feed', undefined, {headers: other})).status === 401, T('feed refused for another signed-in email'));
  if (mode === 'cloudflare-access') {
    for (const [p, b] of [['/api/agent/settings'], ['/api/agent/pending'], ['/api/agent/thread/x'], ['/api/agent/request/x'], ['/api/agent/thread', {id: 't'}], ['/api/agent/cancel', {id: 'x'}], ['/api/agent/thread-split', {id: 'x'}], ['/api/agent/thread-part', {}], ['/api/agent/items', {items: []}]]) {
      ok((await call(p, b, {headers: {}})).status === 401, T(`${p} refused with no token`));
      ok((await call(p, b, {headers: {authorization: 'Bearer wrong'}})).status === 401, T(`${p} refused with a wrong token`));
    }
    ok((await call('/m/m/i1.png', undefined, {headers: {}})).status === 401, T('media refused with no identity'));
    ok((await call('/api/agent/settings', undefined, {headers: {'cf-access-authenticated-user-email': OWNER}})).status === 401, T('the owner header alone is not an agent token'));
    ok((await call('/api/feed', undefined, {headers: {authorization: `Bearer ${TOKEN}`}})).status === 401, T('the agent token alone is not an owner'));
  }
  ok((await call('/api/agent/decisions')).status === 404, T('no decisions export route'));
  {
    const bare = makeEnv(mode); delete bare.env.AUTH_MODE;
    ok((await caller(w, bare.env, mode)('/api/feed')).status === 503, T('refuses to run without AUTH_MODE'));
  }

  // ---- feed and sync ----
  let r = await call('/api/agent/items', {items: [1, 2, 3, 4, 5, 6].map(n => item(n))});
  ok(r.added === 6, T('agent sync adds 6 items'));
  let f = await call('/api/feed');
  ok(f.status === 200 && f.items.length === 6 && f.items.every(i => !i.thread), T('feed lists 6 cards'));
  ok(f.postHold === true && f.postHoldMin === 30 && f.captionMax === 25000, T('feed carries hold defaults and the caption limit'));
  ok((await call('/api/pulse')).feed.length > 0, T('pulse answers'));

  // ---- decide: skip, post, retry dedup, undo ----
  r = await call('/api/decide', {id: 'i6', action: 'pass'});
  ok(r.ok && (await call('/api/feed')).items.length === 5, T('skip removes the card'));
  ok((await call('/api/skipped')).items[0]?.id === 'i6', T('skipped list has it'));
  ok((await call('/api/restore', {id: 'i6'})).ok && (await call('/api/feed')).items[0].id === 'i6', T('restore puts it back on top'));
  const t0 = Date.now();
  r = await call('/api/decide', {id: 'i5', action: 'post', caption: 'my words'});
  const rid = r.requestId, row = one(db, 'SELECT * FROM requests WHERE id = ?', rid);
  ok(r.ok && row.kind === 'post' && row.status === 'queued', T('post queues a request'));
  ok(Date.parse(row.run_at) - t0 >= 25000 && Date.parse(row.run_at) - t0 <= 40000, T('post now waits about 30 s so undo is instant'));
  ok((await call('/api/agent/pending')).requests.length === 0, T('agent cannot claim it during that wait'));
  ok((await call('/api/agent/scheduled')).requests.some(x => x.id === rid), T('agent sees it as scheduled'));
  r = await call('/api/decide', {id: 'i5', action: 'post', caption: 'my words'});
  ok(r.duplicate === true && r.requestId === rid && one(db, 'SELECT COUNT(*) c FROM requests').c === 1, T('a retried POST returns the same request'));
  ok((await call('/api/decide', {id: 'i4', action: 'post', caption: 'x'.repeat(4500)})).ok, T('a 4,500 character caption is accepted'));
  ok((await call('/api/decide', {id: 'i3', action: 'post', caption: 'x'.repeat(25001)})).status === 400, T('a caption past 25,000 is refused'));
  // undo while the agent is posting: request canceled, card back with the edited caption
  db.prepare(`UPDATE requests SET run_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), rid);
  ok((await call('/api/agent/pending')).requests[0]?.id === rid, T('due post is pending'));
  ok((await call('/api/agent/claim', {id: rid})).ok, T('agent claims it'));
  await call('/api/agent/status', {id: rid, status: 'posting'});
  ok((await call('/api/agent/request/' + rid)).status === 'posting', T('agent can poll the request status'));
  r = await call('/api/request', {id: rid, action: 'cancel'});
  ok(r.ok && (await call('/api/agent/request/' + rid)).status === 'canceled', T('undo works while posting'));
  f = await call('/api/feed');
  ok(f.items.find(i => i.id === 'i5')?.caption === 'my words', T('undone post is back in the feed with the caption you wrote'));
  r = await call('/api/agent/status', {id: rid, status: 'failed', result: 'late'});
  ok(r.ignored === true && (await call('/api/agent/request/' + rid)).status === 'canceled', T('a late failed report cannot revive a canceled request'));
  await call('/api/agent/status', {id: rid, status: 'posted', url: 'https://x.com/u/status/1'});
  ok((await call('/api/agent/request/' + rid)).status === 'posted', T('a post that already went out is still recorded as posted'));
  // undo a failed post, and the agent's own cancel route
  r = await call('/api/decide', {id: 'i3', action: 'post', caption: 'third'});
  await call('/api/agent/status', {id: r.requestId, status: 'failed', result: 'nope'});
  ok((await call('/api/agent/cancel', {id: r.requestId})).ok && (await call('/api/feed')).items.some(i => i.id === 'i3'), T('agent cancel restores a failed post'));
  ok((await call('/api/request', {id: r.requestId, action: 'cancel'})).status === 409, T('cannot cancel twice'));
  await call('/api/decide', {id: 'i4', action: 'undo'});

  // ---- post hold settings ----
  ok((await call('/api/agent/settings')).postHold === true, T('hold is on by default for the agent'));
  r = await call('/api/settings', {postHold: false});
  ok(r.ok && r.postHold === false && (await call('/api/agent/settings')).postHold === false, T('switch off reaches the agent'));
  r = await call('/api/settings', {postHoldMin: 15});
  ok(r.postHoldMin === 15 && r.postHold === false, T('gap saves without touching the switch'));
  ok((await call('/api/feed')).postHoldMin === 15, T('feed returns the saved gap'));
  for (const bad of [{postHoldMin: 4}, {postHoldMin: 241}, {postHoldMin: 12.5}, {postHoldMin: '15'}, {postHold: 'yes'}, {}])
    ok((await call('/api/settings', bad)).status === 400, T('settings refuse ' + JSON.stringify(bad)));
  ok((await call('/api/agent/settings')).postHoldMin === 15, T('bad values changed nothing'));
  await call('/api/settings', {postHold: true, postHoldMin: 30});
  // the agent moves a held post, and the app shows that time
  r = await call('/api/decide', {id: 'i4', action: 'post', caption: 'held'});
  const later = new Date(Date.now() + 20 * 60000).toISOString();
  ok((await call('/api/agent/reschedule', {id: r.requestId, runAt: later})).ok, T('agent reschedules a held post'));
  ok((await call('/api/activity')).requests.find(x => x.id === r.requestId)?.runAt === later, T('activity shows the held time'));
  ok((await call('/api/decide', {id: 'i4', action: 'undo'})).ok && one(db, 'SELECT status FROM requests WHERE id = ?', r.requestId).status === 'canceled', T('a held post can be undone'));

  // ---- threads ----
  r = await call('/api/thread', {action: 'make', itemIds: ['i3', 'i1']});
  const tid = r.thread?.threadId;
  ok(r.ok && r.thread.parts.map(p => p.itemId).join() === 'i3,i1' && r.thread.parts[0].text === 'third', T('make a thread from chosen pieces, in order, with their captions'));
  f = await call('/api/feed');
  ok(f.items.filter(i => !i.thread).length === 6 && f.items.filter(i => i.thread).length === 1 && f.items[0].thread, T('pieces stay their own cards, the thread card leads'));
  ok(f.items.find(i => i.id === 'i1').inThread === 'draft' && !f.items.find(i => i.id === 'i2').inThread, T('pieces are tagged In a thread'));
  const t2 = (await call('/api/thread', {action: 'make', itemIds: ['i1', 'i2']})).thread.threadId;
  ok(!!t2, T('a piece can sit in two threads'));
  r = await call('/api/thread', {id: tid, action: 'save', parts: [{itemId: 'i1', text: 'lead'}, {itemId: null, text: 'text only'}, {itemId: 'i3', text: 'last'}]});
  ok(r.ok && r.thread.parts.map(p => p.text).join() === 'lead,text only,last', T('edit and reorder save'));
  ok((await call('/api/feed')).items.find(i => i.id === 'i3').caption === 'third', T('thread text does not change the piece caption'));
  ok((await call('/api/thread', {id: tid, action: 'save', parts: [{itemId: 'i1', text: 'a'}, {itemId: 'i1', text: 'b'}]})).status === 400, T('a piece twice in one thread is refused'));
  ok((await call('/api/thread', {id: tid, action: 'save', parts: []})).status === 400, T('an empty thread is refused'));
  ok((await call('/api/thread', {id: t2, action: 'defer'})).ok && (await call('/api/feed')).items.at(-1).threadId === t2, T('a deferred thread goes to the back'));
  ok((await call('/api/thread', {id: t2, action: 'skip'})).ok && one(db, 'SELECT COUNT(*) c FROM decisions').c === 0, T('skipping a thread writes no decisions'));
  ok((await call('/api/thread', {id: t2, action: 'undoskip'})).ok && one(db, 'SELECT status FROM threads WHERE id = ?', t2).status === 'draft', T('undo skip'));
  ok((await call('/api/thread', {id: t2, action: 'split'})).ok && (await call('/api/feed')).items.filter(i => i.thread).length === 1, T('delete thread'));
  r = await call('/api/thread', {id: tid, action: 'edit', note: 'make it shorter'});
  ok(r.ok && JSON.parse(one(db, 'SELECT payload FROM requests WHERE id = ?', r.requestId).payload).thread === tid, T('thread edit request names the thread'));
  // post, undo before anything is up, post again
  r = await call('/api/thread', {id: tid, action: 'post'});
  const trid = r.requestId, tp = JSON.parse(one(db, 'SELECT payload FROM requests WHERE id = ?', trid).payload);
  ok(r.ok && one(db, 'SELECT kind FROM requests WHERE id = ?', trid).kind === 'thread' && tp.parts.length === 3 && tp.parts[0].num === 1 && tp.parts[1].itemId === null, T('post thread queues one request with every part'));
  f = await call('/api/feed');
  ok(f.items.filter(i => !i.thread).length === 6 && !f.items.some(i => i.thread) && f.items.find(i => i.id === 'i1').inThread === 'queued' && one(db, 'SELECT COUNT(*) c FROM decisions').c === 0, T('posting a thread keeps the pieces and writes no decisions'));
  ok((await call('/api/thread', {id: tid, action: 'undopost'})).ok && one(db, 'SELECT status FROM threads WHERE id = ?', tid).status === 'draft', T('undo returns the thread to a draft'));
  r = await call('/api/thread', {id: tid, action: 'post'});
  const trid2 = r.requestId;
  db.prepare(`UPDATE requests SET run_at = ? WHERE id = ?`).run(new Date(Date.now() - 1000).toISOString(), trid2);
  await call('/api/agent/claim', {id: trid2}); await call('/api/agent/status', {id: trid2, status: 'posting'});
  ok((await call('/api/agent/thread-part', {requestId: trid2, index: 0, url: 'https://x.com/u/status/10'})).ok, T('agent reports the first part'));
  r = await call('/api/request', {id: trid2, action: 'cancel'});
  ok(r.stopped === true && r.up === 1 && one(db, 'SELECT status FROM threads WHERE id = ?', tid).status === 'failed', T('stopping a partly posted thread leaves it failed, not a draft'));
  ok((await call('/api/request', {id: trid2, action: 'retry'})).ok && one(db, 'SELECT status FROM threads WHERE id = ?', tid).status === 'queued', T('retry finishes it'));
  await call('/api/agent/status', {id: trid2, status: 'posted', url: 'https://x.com/u/status/10'});
  ok((await call('/api/activity')).requests.find(x => x.id === trid2)?.url === 'https://x.com/u/status/10', T('activity links the posted thread'));
  ok((await call('/api/feed')).items.find(i => i.id === 'i1').inThread === 'posted', T('piece is tagged Thread posted'));
  // agent: put, get, split
  r = await call('/api/agent/thread', {id: 'draft-1', title: 'From the agent', parts: [{num: 2, text: 'two'}, {text: 'words only'}, {num: 99, text: 'missing'}]});
  ok(r.ok && r.thread.parts.length === 2 && r.skipped.length === 1 && r.skipped[0].num === 99, T('agent thread put leaves out a piece that is not synced'));
  ok((await call('/api/agent/thread/draft-1')).thread.title === 'From the agent', T('agent thread get'));
  ok((await call('/api/agent/thread', {id: 'ghost', parts: [{num: 98, text: 'x'}]})).status === 400 && !one(db, `SELECT id FROM threads WHERE id = 'ghost'`), T('no empty ghost thread'));
  ok((await call('/api/agent/thread', {id: 'bad id!', parts: [{text: 'x'}]})).status === 400, T('bad thread id refused'));
  ok((await call('/api/agent/thread-split', {id: 'draft-1'})).ok && (await call('/api/feed')).items.find(i => i.id === 'i2').caption === 'two', T('agent split keeps the thread text as the caption'));

  // ---- quotes ----
  const Q = {url: 'https://x.com/someone/status/123456789?s=20', handle: 'someone', name: 'Some One', text: 'Quoted words'};
  await call('/api/agent/items', {items: [item(7, {quote: Q}), item(8)]});
  f = await call('/api/feed');
  const q7 = f.items.find(i => i.id === 'i7').quote;
  ok(q7 && q7.url === 'https://x.com/someone/status/123456789' && q7.handle === 'someone', T('feed carries the quote with a trimmed link'));
  ok(f.items.find(i => i.id === 'i8').quote === null, T('no quote on another piece'));
  await call('/api/agent/items', {items: [item(7, {quote: {...Q, text: 'new text'}})]});
  ok((await call('/api/feed')).items.find(i => i.id === 'i7').quote.text === 'new text', T('quote updates without a version change'));
  r = await call('/api/decide', {id: 'i7', action: 'post', caption: 'my take', quoteUrl: Q.url});
  ok(JSON.parse(one(db, 'SELECT payload FROM requests WHERE id = ?', r.requestId).payload).quoteUrl === 'https://x.com/someone/status/123456789', T('post request carries quoteUrl'));
  r = await call('/api/decide', {id: 'i8', action: 'post', caption: 'plain', quoteUrl: ''});
  ok(r.ok && JSON.parse(one(db, 'SELECT payload FROM requests WHERE id = ?', r.requestId).payload).quoteUrl === undefined, T('a plain post has no quoteUrl'));
  const n0 = one(db, 'SELECT COUNT(*) c FROM requests').c;
  ok((await call('/api/decide', {id: 'i2', action: 'post', caption: 'x', quoteUrl: 'https://example.com/foo'})).status === 400 && one(db, 'SELECT COUNT(*) c FROM requests').c === n0, T('a link that is not an X post is refused'));
  await call('/api/agent/items', {items: [item(7, {quote: null})]});
  ok(one(db, `SELECT COUNT(*) c FROM kv WHERE k = 'quote:i7'`).c === 0, T('quote: null clears it'));

  // ---- edits and batches with reference images ----
  r = await call('/api/decide', {id: 'i2', action: 'edit', images: ['refs/2026-01-01/a.jpg', '../etc/passwd', 'm/other.png']});
  ok(r.ok && JSON.stringify(JSON.parse(one(db, 'SELECT payload FROM requests WHERE id = ?', r.requestId).payload).images) === '["refs/2026-01-01/a.jpg"]', T('an edit can be images only, and only refs/ keys are kept'));
  ok((await call('/api/batch', {text: 'ideas', count: 3, images: ['refs/2026-01-01/b.png']})).ok, T('batch with an image'));
}

// ---- CAPTION_MAX ----
{
  const {env} = makeEnv('sites', {vars: {CAPTION_MAX: '280'}}), call = caller(await loadWorker(), env, 'sites');
  await call('/api/agent/items', {items: [item(1)]});
  ok((await call('/api/feed')).captionMax === 280, 'CAPTION_MAX reaches the app');
  ok((await call('/api/decide', {id: 'i1', action: 'post', caption: 'x'.repeat(281)})).status === 400, 'CAPTION_MAX=280 refuses 281 characters');
  ok((await call('/api/decide', {id: 'i1', action: 'post', caption: 'x'.repeat(280)})).ok, 'CAPTION_MAX=280 accepts 280');
}

// ---- migration guards: a database without 0003 (threads) or 0002 (later) still serves the feed ----
for (const [n, name] of [[3, 'without 0003'], [2, 'without 0002 and 0003']]) {
  const {env} = makeEnv('sites', {migrations: n}), call = caller(await loadWorker(), env, 'sites');
  ok((await call('/api/agent/items', {items: [item(1), item(2)]})).added === 2, `${name}: sync works`);
  ok((await call('/api/feed')).items?.length === 2, `${name}: feed works`);
  ok((await call('/api/pulse')).status === 200 && (await call('/api/activity')).status === 200, `${name}: pulse and activity work`);
  ok((await call('/api/thread', {action: 'make', itemIds: ['i1']})).status === 503, `${name}: threads report the missing migration`);
  ok((await call('/api/agent/thread', {id: 't', parts: [{num: 1, text: 'a'}]})).status === 503 && (await call('/api/agent/thread-split', {id: 't'})).status === 503, `${name}: agent threads report it too`);
  ok((await call('/api/decide', {id: 'i1', action: 'post', caption: 'c'})).ok, `${name}: posting works`);
  if (n === 2) ok((await call('/api/defer', {id: 'i2'})).status === 503, `${name}: later reports the missing migration`);
}
process.exit(done('worker') ? 1 : 0);
