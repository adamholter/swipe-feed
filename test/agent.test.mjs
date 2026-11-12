// Agent-side checks with no network: post hold timing, and that a running child can be stopped (the undo path).
// node test/agent.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checker } from './d1-shim.mjs';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swipe-feed-test-'));
process.env.LOG_DIR = tmp; // keep the agent's log folder out of your real one
const H = await import('../agent/post-hold.mjs'), { run } = await import('../agent/lib.mjs');
const {ok, done} = checker(), MIN = 60000, now = Date.parse('2026-01-01T12:00:00Z');

ok(H.gapFrom(15) === 15 * MIN && H.gapFrom(undefined) === 30 * MIN && H.gapFrom(4) === 30 * MIN && H.gapFrom(241) === 30 * MIN, 'gapFrom takes 5 to 240 minutes, else 30');
const ledger = {a: {at: new Date(now - 50 * MIN).toISOString()}, b: {at: new Date(now - 10 * MIN).toISOString()}, c: {at: 'junk'}};
ok(H.lastFromLedger(ledger) === now - 10 * MIN && H.lastFromLedger({}) === 0, 'lastFromLedger takes the newest entry');
ok(H.holdUntil(ledger, 0) === now + 20 * MIN, 'hold ends 30 min after the last post');
ok(H.holdUntil(ledger, now - 2 * MIN, 15 * MIN) === now + 13 * MIN, 'a newer post on the timeline counts, with a custom gap');
ok(H.slots(3, now - 1, now) === null, 'no wait when the hold has passed');
ok(JSON.stringify(H.slots(3, now + 5 * MIN, now, 15 * MIN)) === JSON.stringify([5, 20, 35].map(m => now + m * MIN)), 'several due posts get slots one gap apart');
const tl = [{created_timestamp: (now - 3 * MIN) / 1000, replying_to: 'someone'}, {created_timestamp: (now - 4 * MIN) / 1000, reposted_by: {}}, {created_timestamp: (now - 40 * MIN) / 1000}];
ok(H.lastFromTimeline(tl) === now - 40 * MIN, 'replies and reposts on the timeline do not count');
ok(H.holdOn(tmp, undefined) === true && H.holdOn(tmp, true) === true && H.holdOn(tmp, false) === false, 'hold is on unless the app switch is off');
fs.writeFileSync(path.join(tmp, 'post-hold.off'), '');
ok(H.holdOn(tmp, true) === false, 'post-hold.off turns it off');
H.writeHeld(tmp, {r1: 'x'}); ok(H.readHeld(tmp).r1 === 'x' && JSON.stringify(H.readHeld(path.join(tmp, 'nope'))) === '{}', 'held posts are remembered');
// one ordered queue: slot came up while held, already placed, chosen just now
{
  const iso = m => new Date(now + m * MIN).toISOString(), until = now + 10 * MIN, G = 30 * MIN;
  const mv = H.planHeld([], [{id: 'a', run_at: iso(10)}, {id: 'b', run_at: iso(40)}], [{id: 'c'}], until, G);
  ok(JSON.stringify(mv) === JSON.stringify([{id: 'c', at: now + 70 * MIN}]), 'a new post goes after the ones already waiting, not onto a taken slot');
  const mv2 = H.planHeld([{id: 'a'}], [{id: 'b', run_at: iso(20)}, {id: 'c', run_at: iso(90)}], [], until, G);
  ok(JSON.stringify(mv2) === JSON.stringify([{id: 'a', at: until}, {id: 'b', at: now + 40 * MIN}]), 'a post whose slot came up keeps first place and pushes only the ones too close behind');
  const held = {a: iso(10), b: iso(40), c: iso(70)};
  ok(H.adoptMoved(held, [{id: 'b', run_at: iso(10)}, {id: 'a', run_at: iso(40)}, {id: 'c', run_at: iso(70)}, {id: 'z', run_at: iso(10)}]) && held.a === iso(40) && held.b === iso(10) && !held.z, 'a drag in the app is adopted');
  ok(!H.adoptMoved(held, [{id: 'c', run_at: iso(300)}]) && held.c === iso(70), 'a post moved to its own time is left alone');
}
// timeline: stubbed fetch, never the real service
let calls = 0; const fake = async u => { calls++; return {ok: true, json: async () => ({results: tl}), url: u}; };
ok(await H.timelineLast('', fake, now) === 0 && calls === 0, 'no handle, no timeline call');
ok(await H.timelineLast('somehandle', fake, now) === now - 40 * MIN && calls === 1, 'timeline read through the given fetch');
ok(await H.timelineLast('somehandle', fake, now + 1000) === now - 40 * MIN && calls === 1, 'timeline is cached for 2 minutes');
ok(await H.timelineLast('somehandle', async () => { throw new Error('down'); }, now + 10 * MIN) === 0, 'a failed timeline read fails open');
process.env.POST_HOLD_TIMELINE = '0';
ok(await H.timelineLast('somehandle', fake, now + 20 * MIN) === 0 && calls === 1, 'POST_HOLD_TIMELINE=0 skips the timeline');

// undo: the agent keeps the child from onSpawn and can SIGTERM it mid-run
let child = null; const t0 = Date.now();
const p = run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {onSpawn: c => { child = c; }});
ok(child && child.pid > 0, 'run hands the child to onSpawn');
setTimeout(() => child.kill('SIGTERM'), 300);
const res = await p;
ok(Date.now() - t0 < 10000 && res.code !== 0, 'a SIGTERM stops the run early');
fs.rmSync(tmp, {recursive: true, force: true});
process.exit(done('agent') ? 1 : 0);
