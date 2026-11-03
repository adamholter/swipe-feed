// Cross-post one video + caption to LinkedIn through Codex driving Chrome. Best effort and fully separate from X:
// own Codex session, own queue (agent.mjs), own ledger. A failure here is logged and never touches an X post or its status.
// node linkedin-post.mjs <mediaPath> <captionFile> [--dry-run]  -> prints one JSON line {ok, url?, error?, posted?}
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { run, FEED, LOG_DIR, POST_MODEL } from './lib.mjs';
const [media, capFile, flag] = process.argv.slice(2);
const dry = flag === '--dry-run';
let caption = fs.readFileSync(capFile, 'utf8').trim();
if (caption.length > 3000) caption = caption.slice(0, 2990).replace(/\s+\S*$/, '') + '…';  // LinkedIn's post limit
const LOG = path.join(LOG_DIR, 'linkedin.log');
const STATE = path.join(LOG_DIR, 'linkedin-state.json');
let st = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } })();
if ((st.runs || 0) >= 40) st = {};
const svc = (fs.readFileSync(path.join(process.env.HOME, '.codex/config.toml'), 'utf8').match(/NODE_REPL_TRUSTED_SERVICES = '\{"browser":"([^"]+)"\}'/) || [])[1] || '';
const CLIENT = path.join(path.dirname(svc), 'browser-client.mjs');
const prompt = `You are posting to the owner's personal LinkedIn in their Chrome on this Mac. ${dry ? 'DRY RUN: do everything except the final Post click, then discard the draft.' : ''}
Connect: in the Node REPL js tool (mcp__node_repl__js) run
  if (globalThis.agent?.browsers == null) { const { setupBrowserRuntime } = await import(${JSON.stringify(CLIENT)}); globalThis.agent = await setupBrowserRuntime(); }
  if (globalThis.chrome == null) globalThis.chrome = await agent.browsers.get("chrome");
  then read await chrome.documentation(), and docs "confirmations" and "capabilities/tab/cdp" with agent.documentation.get(name).
Rules:
- Work in ONE background tab that you open yourself with chrome.tabs.new() (url https://www.linkedin.com/feed/?feedli=1). Never claim, focus, navigate or close the owner's own tabs or windows, never make the browser visible, never create more than one tab, and close your tab when finished.
- The owner is already signed in. If LinkedIn shows a login/checkpoint page, stop and report {"ok":false,"posted":false,"error":"not signed in"}.
- FIRST open his profile activity (https://www.linkedin.com/in/me/recent-activity/all/) and look at their newest ~6 posts: if one already starts with the same first 100 characters as the caption below, do NOT post; answer {"ok":true,"url":"<its url or null>","note":"already posted"}.
- Then click "Start a post" on the feed, attach the video file (use the media/photo button, then a file chooser: start const p = tab.playwright.waitForEvent("filechooser", {timeoutMs: 20000}) before clicking, then (await p).setFiles([path])), click Next/Done in the media editor if shown, and enter the caption exactly. Do NOT use fill(): it looks right in the editor but LinkedIn publishes blank lines as a single line break. Type it with the keyboard, using these lines: const lines = ${JSON.stringify(caption.split('\n'))}; click the editor, then for each line i: if it is non-empty await box.pressSequentially(line); if i is not the last, await box.press("Enter"). A blank line means Enter twice. Verify before posting: [...editor.querySelectorAll("p")].map(p => p.innerText.trim()) must equal lines exactly, with one empty paragraph per blank line; if not, clear the editor and retype. Add nothing: no hashtags, no extra text.
- Wait for the video upload to finish, then click Post at most once in total, ever. If anything is unclear after clicking Post, check the recent-activity page and report; never click Post a second time.
- Media file: ${media}
- Caption, exactly:
<<<CAPTION
${caption}
CAPTION>>>
Final answer: exactly one JSON line: ${dry ? '{"ok":true,"dryRun":true,"html":"<editor innerHTML>"} or {"ok":false,"error":"...","posted":false}' : '{"ok":true,"url":"https://www.linkedin.com/feed/update/<urn>"} or {"ok":false,"error":"...","posted":<true|false|null>}'}`;
const outFile = path.join(os.tmpdir(), `post-li-${process.pid}.txt`);
const common = ['-m', POST_MODEL, '-c', 'model_reasoning_effort="medium"', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-o', outFile];
const args = st.session ? ['exec', 'resume', st.session, ...common, prompt] : ['exec', ...common, '-C', FEED, prompt];
let res;
try {
  const {code, out} = await run(process.env.HOME + '/.local/bin/codex', args, {timeoutMs: 25 * 60000, input: '', cwd: FEED});
  const sid = (out.match(/session id: ([0-9a-f-]{36})/) || [])[1];
  if (sid && sid !== st.session) st = {session: sid, runs: 0}; else if (!sid && st.session) st = {};
  st.runs = (st.runs || 0) + 1; fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
  fs.appendFileSync(LOG, `\n==== ${new Date().toISOString()} ${media} dry=${dry} code=${code}\n${out.slice(-4000)}\n`);
  const txt = fs.readFileSync(outFile, 'utf8'), m = txt.match(/\{[^{}]*"ok"\s*:\s*(true|false)[^{}]*\}/);
  res = m ? JSON.parse(m[0]) : {ok: false, error: `no result (codex exited ${code})`, posted: null};
} catch (e) { res = {ok: false, error: String(e.message).slice(0, 200), posted: null}; }
fs.rmSync(outFile, {force: true});
console.log(JSON.stringify(res));
