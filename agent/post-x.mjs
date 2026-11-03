// Post one video/image to X through Codex driving Chrome. A cheap model runs the script; it reasons more on the fallback.
// Attempt 1 runs the fast scripted path (x-post-script.js). If that fails without posting, the model does the post
// itself with the browser tools, persistently. Any X tabs an attempt opened are closed afterwards; no windows are opened.
// node post-x.mjs <mediaPath> <captionFile> [--dry-run]  -> prints one JSON line {ok, url?, error?, posted?}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run, FEED, LOG_DIR, X_HANDLE, POST_MODEL } from './lib.mjs';
const [media, capFile, flag] = process.argv.slice(2);
const dry = flag === '--dry-run';
const caption = fs.readFileSync(capFile, 'utf8').trim();
const LOG = path.join(LOG_DIR, 'post-x.log');
const osa = src => { try { return execFileSync('/usr/bin/osascript', ['-e', src], {encoding: 'utf8', timeout: 30000}).trim(); } catch { return ''; } };
const tabIds = () => new Set(osa('set out to ""\ntell application "Google Chrome"\nrepeat with w in windows\nrepeat with t in tabs of w\nset out to out & (id of t) & ","\nend repeat\nend repeat\nend tell\nreturn out').split(',').filter(Boolean));
// Every attempt resumes one long-lived Codex session that owns the poster tab, which sits in its own background agent tab
// group ("📣 Feed poster", URL marker feedposter=1) so it never lands in or focuses the owner's windows. A tab stays bound to the
// session that opened it, so the session is reused. After MAX_RUNS the session rotates: its tab (and so its group) is closed
// and the next session opens a fresh one. Groups are created once per rotation, not per post (per-post tab groups synced across machines and crashed Chrome).
const STATE = path.join(LOG_DIR, 'poster-state.json'), MAX_RUNS = 40;
let st = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } })();
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
const closeMarkerTabs = () => osa('tell application "Google Chrome"\nrepeat with w in windows\nrepeat with i from (count of tabs of w) to 1 by -1\nif (URL of tab i of w) contains "feedposter=1" then close tab i of w\nend repeat\nend repeat\nend tell');
if (st.session && (st.runs || 0) >= MAX_RUNS) { closeMarkerTabs(); st = {}; saveState(); }
// The poster works in its own hidden Chrome window (AppleScript visible=false) (found by its marker tab, feedposter=1), never in the owner's windows.
// Made once if missing; each run then adds a fresh tab there, files it into the window's "📣 Feed poster" group and closes
// the previous one, so the group itself is never re-created (per-post groups crashed another machine's Chrome via Sync).
const POSTER_URL = `https://x.com/${X_HANDLE}?feedposter=1`;
const ensurePosterWindow = () => osa(`tell application "Google Chrome"\nrepeat with w in windows\nrepeat with t in tabs of w\nif (URL of t) contains "feedposter=1" then return "ok"\nend repeat\nend repeat\nset nw to make new window\nset nid to (id of nw)\nset URL of active tab of (window id nid) to "${POSTER_URL}"\nset visible of (window id nid) to false\nreturn "made"\nend tell`);
ensurePosterWindow();
const hidePosterWindow = () => { try { osa('tell application "Google Chrome"\nset ids to {}\nrepeat with w in windows\nrepeat with t in tabs of w\nif (URL of t) contains "feedposter=1" then set end of ids to (id of w)\nend repeat\nend repeat\nrepeat with i in ids\nset visible of (window id i) to false\nend repeat\nend tell'); } catch {} };
hidePosterWindow();
// close tabs that appeared during this attempt and point at X (or are blank); never touch tabs that existed before
function cleanup(before) {
  const listing = osa('set out to ""\ntell application "Google Chrome"\nrepeat with w in windows\nrepeat with t in tabs of w\nset out to out & (id of t) & "|" & (URL of t) & linefeed\nend repeat\nend repeat\nend tell\nreturn out');
  for (const line of listing.split('\n')) {
    const [id, url = ''] = line.split('|');
    if (id && !before.has(id) && !url.includes('feedposter=1') && /^(https:\/\/(x|twitter)\.com\/|chrome:\/\/newtab|about:blank)/.test(url)) osa(`tell application "Google Chrome"\nrepeat with w in windows\nrepeat with t in tabs of w\nif (id of t as text) is "${id}" then close t\nend repeat\nend repeat\nend tell`);
  }
}
const svc = (fs.readFileSync(path.join(process.env.HOME, '.codex/config.toml'), 'utf8').match(/NODE_REPL_TRUSTED_SERVICES = '\{"browser":"([^"]+)"\}'/) || [])[1] || '';
const CLIENT = path.join(path.dirname(svc), 'browser-client.mjs');
const fill = s => s.replaceAll('__MEDIA__', JSON.stringify(media)).replaceAll('__CAPTION__', JSON.stringify(caption)).replaceAll('__DRY__', String(dry)).replaceAll('__CLIENT__', JSON.stringify(CLIENT)).replaceAll('__TABID__', JSON.stringify(st.tabId || null)).replaceAll('__HANDLE__', JSON.stringify(X_HANDLE));
// the filled script goes in a module file so the model only has to run one short line (it used to retype ~9 KB and sometimes mangled it)
const scriptFile = path.join(os.tmpdir(), `x-post-${process.pid}-${Date.now()}.mjs`);
fs.writeFileSync(scriptFile, fill('export default async function (nodeRepl) {\n' + fs.readFileSync(path.join(FEED, 'agent/x-post-script.js'), 'utf8') + '\n}\n'));
const script = `await (await import(${JSON.stringify('file://' + scriptFile + '?v=' + Date.now())})).default(nodeRepl);`;

const scriptedPrompt = `Run the one line of JavaScript below EXACTLY as written (it loads a prepared script file), in one call to the Node REPL js tool (mcp__node_repl__js) with timeout_ms 900000. Do not rewrite it. The script opens its own tab, checks the profile so it never double-posts, attaches the video, types the caption, ${dry ? 'and stops before posting (dry run)' : 'clicks Post'}, closes its tab and prints one JSON line. If the js tool call itself errors, call it once more with the same code. Your final answer must be only the JSON line the script printed.

\`\`\`js
${script}
\`\`\``;

const agentPrompt = prior => `You are posting to X for the account @${X_HANDLE} in the owner's Chrome. ${dry ? 'DRY RUN: do everything except the final Post click, then discard the draft.' : ''}
This setup is known to work. Get this post published. An earlier scripted attempt just failed with: ${JSON.stringify(String(prior).slice(0, 300))}. That failure is not a reason to stop, and neither is any single error you hit. Errors here are almost always transient or fixable: retry, wait and retry, reconnect the browser runtime, open a fresh tab, or switch approach. Keep working until the post is live; you have up to 30 minutes. Only report failure if you have genuinely exhausted every approach below.

Connect: in the Node REPL js tool (mcp__node_repl__js) run
  if (globalThis.agent?.browsers == null) { const { setupBrowserRuntime } = await import(${JSON.stringify(CLIENT)}); globalThis.agent = await setupBrowserRuntime(); }
  if (globalThis.chrome == null) globalThis.chrome = await agent.browsers.get("chrome");
  then read await chrome.documentation(), and read docs "confirmations" and "capabilities/tab/cdp" with agent.documentation.get(name) before raw CDP.
What has worked: get the poster tab as above; await tab.goto(url); const cdp = await tab.capabilities.get("cdp"); cdp.send("Runtime.evaluate", {expression, returnByValue: true}) to read the page (Playwright locators are slow on X; prefer CDP); to attach: start const p = tab.playwright.waitForEvent("filechooser", {timeoutMs: 20000}) then cdp.send("Runtime.evaluate", {expression: "document.querySelector('input[data-testid=\\"fileInput\\"]').click()", userGesture: true}); (await p).setFiles([path]). Retry that a few times; it often works on the 2nd or 3rd try. Type the caption with tab.playwright.locator('[data-testid="tweetTextarea_0"]').first().fill(captionText): it keeps line breaks. Do NOT use document.execCommand('insertText'/'insertParagraph'): X's composer shows those breaks on screen but posts the caption without them.* commands are refused by the browser plugin). Post with Runtime.evaluate clicking [data-testid="tweetButton"] once it is enabled (video finished processing). If the browser API truly cannot work, use computer use on Chrome instead.

Rules:
- Use the poster's own tab in its background agent tab group: const t = (await chrome.user.openTabs()).find(x => String(x.url).includes("feedposter=1")); const tab = t ? await chrome.user.claimTab(t) : (await chrome.nameSession("📣 Feed poster"), await chrome.tabs.new()); (claiming keeps it in its group; tabs.new() puts a new one in the agent group in the background). Tab ids from earlier runs are not valid here. Open at most one tab. Never claim, open in, focus or show the owner's own tabs or windows, and never make the browser visible. Do not close the poster tab; when finished, navigate it back to https://x.com/${X_HANDLE}?feedposter=1. Never touch any other tabs.
- FIRST open https://x.com/${X_HANDLE} and check the newest ~8 posts: if one already starts with the same first 100 characters as this caption (long posts are cut off with "Show more" on the profile, so compare only the start), do NOT post again; answer with its URL. Click Post at most once in total, ever: if anything is unclear after clicking, check the profile and report, never click Post a second time.
- Attach this file: ${media}
- Caption, exactly (keep line breaks, add nothing):
<<<CAPTION
${caption}
CAPTION>>>
- Post once only. Get the new post's URL from the "Your post was sent" toast or from the profile.

Final answer: exactly one JSON line: ${dry ? '{"ok":true,"dryRun":true} or {"ok":false,"error":"...","posted":false}' : '{"ok":true,"url":"https://x.com/'+X_HANDLE+'/status/<id>"} or {"ok":false,"error":"...","posted":<true|false|null>}'}`;

async function attempt(label, prompt, effort, timeoutMs) {
  const outFile = path.join(os.tmpdir(), `post-x-${process.pid}-${label}.txt`);
  const before = tabIds();
  const common = ['-m', POST_MODEL, '-c', `model_reasoning_effort="${effort}"`, '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-o', outFile];
  const args = st.session ? ['exec', 'resume', st.session, ...common, prompt] : ['exec', ...common, '-C', FEED, prompt];
  const {code, out} = await run(process.env.HOME + '/.local/bin/codex', args, {timeoutMs, input: '', cwd: FEED});
  const sid = (out.match(/session id: ([0-9a-f-]{36})/) || [])[1];
  if (sid && sid !== st.session) st = {session: sid, tabId: null, runs: 0};
  else if (!sid && st.session) st = {};  // resume failed (session gone): start fresh next attempt
  st.runs = (st.runs || 0) + 1; saveState();
  cleanup(before);
  hidePosterWindow();
  fs.appendFileSync(LOG, `\n==== ${new Date().toISOString()} ${label} ${media} dry=${dry} code=${code}\n${out.slice(-5000)}\n`);
  try {
    const txt = fs.readFileSync(outFile, 'utf8');
    const m = txt.match(/\{[^{}]*"ok"\s*:\s*(true|false)[\s\S]*\}/);
    const res = JSON.parse(m ? m[0].replace(/,"log":\[[\s\S]*$/, '}') : txt.trim());
    if (res.tabId) { st.tabId = res.tabId; saveState(); }
    return res;
  } catch { return {ok: false, error: `${label}: no result (codex exited ${code})`, posted: null}; }
}

let res = await attempt('scripted', scriptedPrompt, 'low', 15 * 60000);
if (!res.ok && res.posted === false && !/clicked Post/.test(JSON.stringify(res.log || []))) {
  const fb = await attempt('agentic', agentPrompt(res.error), 'medium', 35 * 60000);
  res = fb.ok ? {...fb, note: 'agentic fallback'} : {...fb, error: `scripted: ${res.error} | agentic: ${fb.error}`};
}
fs.rmSync(scriptFile, {force: true});
console.log(JSON.stringify(res));
