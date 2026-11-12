// POST HOLD: on by default. A post you chose waits until N minutes (30 unless you change it in the app) after your last post,
// counted from the posted ledger and, when it can be read, your public X timeline, so posts made outside the app count too.
// Why: X's open-source ranker (xai-org/x-algorithm, xai-value-model/scoring.rs) docks a viewer's lower-ranked posts from the same
// author in one feed request, and a post they've already seen stops counting. The benefit of spacing is unmeasured.
// Off: the switch in the app's Activity sheet, or touch post-hold.off in the log folder. Any error here fails open: a broken check must never block a post.
// The timeline is read through api.fxtwitter.com, a third-party service that sees your handle. Set POST_HOLD_TIMELINE=0 in .env to use the ledger alone.
import fs from 'node:fs';
import path from 'node:path';

export const GAP_MS = 30 * 60000; // default; tune it in the app (kv post_hold_min)
export const gapFrom = min => (Number.isFinite(min) && min >= 5 && min <= 240 ? min * 60000 : GAP_MS);
const TIMELINE_EVERY = 2 * 60000;
let cached = {at: 0, ms: 0};

export const lastFromLedger = ledger => Math.max(0, ...Object.values(ledger || {}).map(e => Date.parse(e.at) || 0));

// Newest original post on the timeline: replies and reposts don't count. 0 if it can't be read.
export function lastFromTimeline(results) {
  let ms = 0;
  for (const t of results || []) {
    if (t.replying_to || t.replying_to_status || t.reposted_by || t.is_repost) continue;
    const at = (t.created_timestamp || 0) * 1000;
    if (at > ms) ms = at;
  }
  return ms;
}

export async function timelineLast(handle, fetchFn = fetch, now = Date.now()) {
  if (!handle || process.env.POST_HOLD_TIMELINE === '0') return 0;
  if (now - cached.at < TIMELINE_EVERY) return cached.ms;
  let ms = 0;
  try {
    const r = await fetchFn(`https://api.fxtwitter.com/2/profile/${encodeURIComponent(handle)}/statuses`, {signal: AbortSignal.timeout(8000)});
    if (r.ok) ms = lastFromTimeline((await r.json()).results);
  } catch {}
  cached = {at: now, ms};
  return ms;
}

// The moment the next post may start. Past or 0 means no wait.
export const holdUntil = (ledger, timelineMs, gapMs = GAP_MS) => Math.max(lastFromLedger(ledger), timelineMs || 0) + gapMs;

// Slots for the due posts in order: the first at the hold time, then one gap apart.
export const slots = (n, until, now = Date.now(), gapMs = GAP_MS) => {
  if (until <= now) return null;
  return Array.from({length: n}, (_, i) => until + i * gapMs);
};

export function holdOn(logDir, setting) {
  try { if (fs.existsSync(path.join(logDir, 'post-hold.off'))) return false; } catch {}
  return setting !== false;
}

// Posts this hold moved, with the time it gave them, so switching off can release them.
const heldFile = logDir => path.join(logDir, 'post-held.json');
export const readHeld = logDir => { try { return JSON.parse(fs.readFileSync(heldFile(logDir), 'utf8')); } catch { return {}; } };
export const writeHeld = (logDir, held) => { try { fs.writeFileSync(heldFile(logDir), JSON.stringify(held, null, 1)); } catch {} };
