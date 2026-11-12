// Post one video/image (or text only) to X through Codex driving Chrome. A cheap model runs the script; it reasons more on the fallback.
// Attempt 1 runs the fast scripted path (x-post-script.js). If that fails without posting, the model does the post
// itself with the browser tools, persistently. Any X tabs an attempt opened are closed afterwards; no windows are opened.
// --reply-to makes it a reply (a thread part), --quote a quote post, --anchor keeps one tab group for a whole thread,
// --cancel-file names the file the agent writes when you undo a post in flight.
// node post-x.mjs <mediaPath|none> <captionFile> [--dry-run] [--reply-to <statusUrl>] [--quote <statusUrl>] [--anchor] [--cancel-file <path>]  -> prints one JSON line {ok, url?, error?, posted?}
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { run, FEED, LOG_DIR, X_HANDLE, POST_MODEL } from './lib.mjs';
const argv = process.argv.slice(2), [mediaArg, capFile] = argv, media = mediaArg === 'none' ? null : mediaArg;
const useAnchor = argv.includes('--anchor');
const cancelFile = argv.includes('--cancel-file') ? argv[argv.indexOf('--cancel-file') + 1] : null;
const dry = argv.includes('--dry-run'), replyTo = argv.includes('--reply-to') ? argv[argv.indexOf('--reply-to') + 1] : null;
const quoteArg = argv.includes('--quote') ? argv[argv.indexOf('--quote') + 1] : null, quote = quoteArg && /^https:\/\/(x|twitter)\.com\/\w+\/status\/\d+/.test(quoteArg) ? quoteArg.match(/^https:\/\/(?:x|twitter)\.com\/\w+\/status\/\d+/)[0] : null;
const caption = fs.readFileSync(capFile, 'utf8').trim();
const LOG = path.join(LOG_DIR, 'post-x.log');
const osa = src => { try { return execFileSync('/usr/bin/osascript', ['-e', src], {encoding: 'utf8', timeout: 30000}).trim(); } catch { return ''; } };
const tabIds = () => new Set(osa('set out to ""\ntell application "Google Chrome"\nrepeat with w in windows\nrepeat with t in tabs of w\nset out to out & (id of t) & ","\nend repeat\nend repeat\nend tell\nreturn out').split(',').filter(Boolean));
// Every attempt resumes one long-lived Codex session. Its worker tab opens in the session's own background agent tab group
// ("📣 Feed poster", URL marker feedposter=1), so it never lands in or focuses your windows, and it closes when the run ends.
// After MAX_RUNS the session rotates and the next attempt starts a fresh one.
const STATE = path.join(LOG_DIR, 'poster-state.json'), MAX_RUNS = 40;
let st = (() => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } })();
const saveState = () => fs.writeFileSync(STATE, JSON.stringify(st, null, 1));
const closeMarkerTabs = () => osa('tell application "Google Chrome"\nrepeat with w in windows\nrepeat with i from (count of tabs of w) to 1 by -1\nif (URL of tab i of w) contains "feedposter=1" then close tab i of w\nend repeat\nend repeat\nend tell');
const closeAnchors = () => osa('tell application "Google Chrome"\nrepeat with w in windows\nrepeat with i from (count of tabs of w) to 1 by -1\nif (URL of tab i of w) contains "feedanchor=1" then close tab i of w\nend repeat\nend repeat\nend tell');
if (st.session && (st.runs || 0) >= MAX_RUNS) { closeMarkerTabs(); closeAnchors(); st = {}; saveState(); }
// close tabs that appeared during this attempt and point at X (or are blank); never touch tabs that existed before
function cleanup(before) {
  const listing = osa('set out to ""\ntell application "Google Chrome"\nrepeat with w in windows\nrepeat with t in tabs of w\nset out to out & (id of t) & "|" & (URL of t) & linefeed\nend repeat\nend repeat\nend tell\nreturn out');
  for (const line of listing.split('\n')) {
    const [id, url = ''] = line.split('|');
    if (id && !before.has(id) && !url.includes('feedposter=1') && !url.includes('feedanchor=1') && /^(https:\/\/(x|twitter)\.com\/|chrome:\/\/newtab|about:blank)/.test(url)) osa(`tell application "Google Chrome"\nrepeat with w in windows\nrepeat with t in tabs of w\nif (id of t as text) is "${id}" then close t\nend repeat\nend repeat\nend tell`);
  }
}
const svc = (fs.readFileSync(path.join(process.env.HOME, '.codex/config.toml'), 'utf8').match(/NODE_REPL_TRUSTED_SERVICES = '\{"browser":"([^"]+)"\}'/) || [])[1] || '';
// The configured plugin version can vanish after a Codex update; fall back to the newest browser client still on disk.
const newestClient = () => { const base = path.join(process.env.HOME, '.codex/plugins/cache/openai-bundled'); const found = [];
  for (const pl of ['browser', 'chrome']) { let vs = []; try { vs = fs.readdirSync(path.join(base, pl)); } catch {} for (const v of vs) { const f = path.join(base, pl, v, 'scripts/browser-client.mjs'); try { found.push([fs.statSync(f).mtimeMs, f]); } catch {} } }
  return found.sort((a, b) => b[0] - a[0])[0]?.[1]; };
const CONFIG_CLIENT = path.join(path.dirname(svc), 'browser-client.mjs');
const CLIENT = fs.existsSync(CONFIG_CLIENT) ? CONFIG_CLIENT : (newestClient() || CONFIG_CLIENT);
const fill = s => s.replaceAll('__MEDIA__', JSON.stringify(media)).replaceAll('__CAPTION__', JSON.stringify(caption)).replaceAll('__ANCHOR__', String(useAnchor)).replaceAll('__CANCEL__', JSON.stringify(dry ? null : cancelFile)).replaceAll('__DRY__', String(dry)).replaceAll('__CLIENT__', JSON.stringify(CLIENT)).replaceAll('__TABID__', JSON.stringify(st.tabId || null)).replaceAll('__REPLY__', JSON.stringify(replyTo)).replaceAll('__QUOTE__', JSON.stringify(quote)).replaceAll('__HANDLE__', JSON.stringify(X_HANDLE));
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
${replyTo ? `- THIS POST IS A REPLY in a thread. It must reply to ${replyTo}: open that URL and use its inline "Post your reply" box. It must never go out as a standalone post. Check that post's replies, not the profile, for an existing copy.\n` : ''}${quote ? `- THIS IS A QUOTE POST of ${quote}. After the caption, on its own last line, put that link (or open that post and use Repost > Quote). Before posting, the composer must show the quoted post as a card under the text. The published post's text will not include the link.\n` : ''}${media ? `- Attach this file: ${media}` : '- Text only: no media.'}
- Caption, exactly (keep line breaks, add nothing):
<<<CAPTION
${caption}
CAPTION>>>
${cancelFile && !dry ? `- Immediately before clicking Post, check whether the file ${cancelFile} exists. If it does, do not post: stop and report {"ok":false,"error":"undone","posted":false}. If not, create ${cancelFile}.clicked and click.\n` : ''}- Post once only. Get the new post's URL from the "Your post was sent" toast or from the profile.

Final answer: exactly one JSON line: ${dry ? '{"ok":true,"dryRun":true} or {"ok":false,"error":"...","posted":false}' : '{"ok":true,"url":"https://x.com/'+X_HANDLE+'/status/<id>"} or {"ok":false,"error":"...","posted":<true|false|null>}'}`;

// Undo: the agent sends SIGTERM. Kill Codex and its browser REPL, then let the exit handler close the tabs.
let codexChild = null, lastBefore = null;
process.on('SIGTERM', () => {
  try { if (codexChild?.pid) { execFileSync('/usr/bin/pkill', ['-TERM', '-P', String(codexChild.pid)], {stdio: 'ignore'}); } } catch {}
  try { codexChild?.kill('SIGTERM'); } catch {}
  process.exit(143);
});
async function attempt(label, prompt, effort, timeoutMs) {
  const outFile = path.join(os.tmpdir(), `post-x-${process.pid}-${label}.txt`);
  const before = tabIds(); lastBefore = before;
  const common = ['-m', POST_MODEL, '-c', `model_reasoning_effort="${effort}"`, '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-o', outFile];
  const args = st.session ? ['exec', 'resume', st.session, ...common, prompt] : ['exec', ...common, '-C', FEED, prompt];
  const {code, out} = await run(process.env.HOME + '/.local/bin/codex', args, {timeoutMs, input: '', cwd: FEED, onSpawn: c => { codexChild = c; }});
  const sid = (out.match(/session id: ([0-9a-f-]{36})/) || [])[1];
  if (sid && sid !== st.session) st = {session: sid, tabId: null, runs: 0};
  else if (!sid && st.session) st = {};  // resume failed (session gone): start fresh next attempt
  st.runs = (st.runs || 0) + 1; saveState();
  cleanup(before);
  fs.appendFileSync(LOG, `\n==== ${new Date().toISOString()} ${label} ${media} dry=${dry} code=${code}\n${out.slice(-5000)}\n`);
  try {
    const txt = fs.readFileSync(outFile, 'utf8');
    const m = txt.match(/\{[^{}]*"ok"\s*:\s*(true|false)[\s\S]*\}/);
    const res = JSON.parse(m ? m[0].replace(/,"log":\[[\s\S]*$/, '}') : txt.trim());
    if (res.tabId) { st.tabId = res.tabId; saveState(); }
    return res;
  } catch { return {ok: false, error: `${label}: no result (codex exited ${code})`, posted: null}; }
}

// Leave nothing behind: when this process ends, every poster tab goes. The next post opens its own.
process.on('exit', () => { closeMarkerTabs(); closeMarkerTabs(); if (!useAnchor) closeAnchors(); if (lastBefore) cleanup(lastBefore); });  // twice: closing a tab can reshuffle the list mid-loop
let res = await attempt('scripted', scriptedPrompt, 'low', 15 * 60000);
if (!res.ok && res.posted === false && !/clicked Post/.test(JSON.stringify(res.log || [])) && !(cancelFile && fs.existsSync(cancelFile))) {
  const fb = await attempt('agentic', agentPrompt(res.error), 'medium', 35 * 60000);
  res = fb.ok ? {...fb, note: 'agentic fallback'} : {...fb, error: `scripted: ${res.error} | agentic: ${fb.error}`};
}
fs.rmSync(scriptFile, {force: true});
console.log(JSON.stringify(res));
