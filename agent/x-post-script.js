// Runs inside Codex's node_repl (trusted browser service). post-x.mjs fills in the __PLACEHOLDERS__ below.
// Uses raw CDP (Runtime.evaluate) plus locator typing because Playwright-style locators time out on X's huge DOM.
// REPLY_URL (threads): the post this one must reply to. Null for a normal post. MEDIA is null for a text-only post.
const ANCHOR = __ANCHOR__, CANCEL = __CANCEL__, MEDIA = __MEDIA__, CAPTION = __CAPTION__, DRY = __DRY__, CLIENT = __CLIENT__, TABID = __TABID__, HANDLE = __HANDLE__, REPLY_URL = __REPLY__, QUOTE_URL = __QUOTE__;
// QUOTE_URL (quote posts): the post to quote. Its link is typed on its own last line; X turns a trailing post link into the quoted card and drops the link from the text.
// The profile and reply checks keep comparing CAPTION alone, because the published text no longer ends with the link.
const TYPE_TEXT = QUOTE_URL ? CAPTION + "\n" + QUOTE_URL : CAPTION, QUOTE_ID = QUOTE_URL ? (String(QUOTE_URL).match(/status\/(\d+)/) || [])[1] || null : null;
const REPLY_ID = REPLY_URL ? (String(REPLY_URL).match(/status\/(\d+)/) || [])[1] || "bad" : null, HOME_POST = REPLY_ID ? `https://x.com/${HANDLE}/status/${REPLY_ID}` : `https://x.com/${HANDLE}`;
const log = []; let result, tab, keepTab = false, maybeSent = false;
const HOME_URL = `https://x.com/${HANDLE}?feedposter=1`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || "").replace(/\s+/g, " ").trim();
try {
  if (globalThis.agent?.browsers == null) { const { setupBrowserRuntime } = await import(CLIENT); globalThis.agent = await setupBrowserRuntime(); }
  if (globalThis.chrome == null) globalThis.chrome = await agent.browsers.get("chrome");
  // the runtime refuses raw CDP until these docs have been read in this session
  for (const name of ["confirmations", "capabilities/tab/cdp"]) { try { await agent.documentation.get(name); } catch (e) { log.push(`doc ${name}: ${String(e.message).slice(0, 80)}`); } }
  // Every run opens a fresh worker tab with tabs.new(), which puts it in this session's background agent tab group
  // ("📣 Feed poster"). Tabs claimed from an earlier run keep a stale debugger ("Debugger unattached"), so none is reused.
  // Never claim your own tabs.
  const {execFileSync} = await import("node:child_process");
  const osa = src => execFileSync("osascript", ["-e", src], {encoding: "utf8"}).trim();
  const RUN = "feedrun=" + Date.now();
  // Background agent tab group only: never a new window, never AppleScript tab creation, never focus.
  // No tab group stays open after posting. A single post's group goes when its worker tab closes. A thread opens one parked anchor tab
  // (ANCHOR) so its parts share a group, and the agent closes that tab when the thread ends.
  const newPosterTab = async () => {
    try { await chrome.nameSession("\u{1F4E3} Feed poster"); } catch (e) {}
    try { const found = String(osa(`tell application "Google Chrome"\nset n to 0\nrepeat with i from 1 to count of windows\nrepeat with t in tabs of window i\nif (URL of t) contains "feedanchor=1" then set n to n + 1\nend repeat\nend repeat\nreturn n\nend tell`) || "0").trim();
      log.push(`anchors: ${found}`);
      if (found === "0" && ANCHOR) { const a = await chrome.tabs.new(); await a.goto("https://x.com/robots.txt?feedanchor=1"); log.push("anchor tab opened"); }
    } catch (e) { log.push(`anchor: ${String(e.message).slice(0, 100)}`); }
    const t = await chrome.tabs.new(); log.push("agent worker tab");
    try { const mg = await chrome.capabilities.get("management"); const all = await mg.tabs.query({}); const gs = [...new Set(all.filter(x => String(x.url).includes("feedanchor=1") && x.groupId > -1).map(x => x.groupId))]; log.push("groups: " + gs.join(",")); for (const g of gs) await mg.tabGroups.update(g, {collapsed: true}); } catch (e) { log.push(`groups: ${String(e.message).slice(0, 60)}`); }
    return t; };
  const closeOldPosterTabs = () => { try { osa(`tell application "Google Chrome"\nrepeat with w in windows\nrepeat with i from (count of tabs of w) to 1 by -1\nset u to URL of tab i of w\nif u contains "feedposter=1" and u does not contain "${RUN}" then close tab i of w\nend repeat\nend repeat\nend tell`); } catch (e) { log.push(`close old: ${String(e.message).slice(0, 60)}`); } };
  tab = await newPosterTab(); keepTab = false; closeOldPosterTabs();
  let cdp = null;
  const ev = async expr => {
    const r = await cdp.send("Runtime.evaluate", {expression: expr, returnByValue: true, awaitPromise: true}, {timeoutMs: 20000});
    if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r?.result?.value;
  };
  async function until(name, expr, budgetMs) {
    const t0 = Date.now(); let last;
    while (Date.now() - t0 < budgetMs) {
      try { if (await ev(expr)) { log.push(`${name} ok ${Math.round((Date.now() - t0) / 1000)}s`); return true; } } catch (e) { last = e; }
      await sleep(1500);
    }
    throw new Error(`${name}: not ready after ${budgetMs / 1000}s${last ? ' (' + String(last.message).slice(0, 120) + ')' : ''}`);
  }
  async function open(url, readyExpr, name) {
    for (let i = 0; i < 3; i++) {
      try { await tab.goto(url); cdp = await tab.capabilities.get("cdp"); if (!cdp._docRead) { try { await cdp.documentation?.(); } catch {} cdp._docRead = true; } await until(name, readyExpr, 60000); return; }
      catch (e) { log.push(`${name} load ${i + 1}: ${String(e.message).slice(0, 120)}`); await sleep(3000); }
    }
    // a stale debugger attachment ("Debugger unattached") survives retries on the same tab: swap in a fresh poster tab once
    if (!open.swapped) { open.swapped = true; log.push(`${name}: another fresh tab`); tab = await newPosterTab(); closeOldPosterTabs(); return open(url, readyExpr, name); }
    throw new Error(`${name}: page never became ready`);
  }
  const FIND = `(() => { const n = s => String(s || "").replace(/Show more$/, "").replace(/\\s+/g, " ").trim(); const cap = n(${JSON.stringify(CAPTION)}).slice(0, 100);
    for (const a of [...document.querySelectorAll("article")].slice(0, ${REPLY_ID ? 40 : 8})) {
      const t = a.querySelector('[data-testid="tweetText"]'), l = a.querySelector('a[href*="/status/"] time')?.closest("a");
      if (t && l && n(t.innerText).slice(0, 100) === cap && !l.getAttribute("href").endsWith(${JSON.stringify(REPLY_ID ? "/status/" + REPLY_ID : "//")})) return "https://x.com" + l.getAttribute("href"); }
    return null; })()`;

  // never double-post: if one of the newest posts already has this exact caption, report it instead
  let existing = null;
  if (!DRY) {
    await open(HOME_POST, `!!document.querySelector('article [data-testid="tweetText"]')`, REPLY_ID ? "parent post" : "profile");
    await sleep(1500);
    existing = await ev(FIND);
  }
  if (existing) result = {ok: true, url: existing, note: "already posted"};
  else {
    // the home timeline composer (Draft.js) keeps line breaks; the compose/post popup editor drops them when X reads it
    // A thread reply is typed in the parent post's own inline reply box, so nothing can land as a standalone post (the guard below also checks the reply id).
    await open(REPLY_ID ? HOME_POST : "https://x.com/home", `!!(document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]') || document.querySelector('[data-testid="tweetTextarea_0"]'))`, "composer");
    const signedIn = await ev(`document.body.innerText.includes("@${HANDLE}")`).catch(() => null);
    if (signedIn === false) throw new Error("NOT_LOGGED_IN as @" + HANDLE);

    // attach through the file-chooser flow; open the chooser with a user-gesture click (or a real mouse click on the media button)
    let attached = !MEDIA;
    if (REPLY_ID) { await ev(`document.querySelector('[data-testid="tweetTextarea_0"]').click()`).catch(() => {}); await sleep(800); }
    for (let i = 0; i < 8 && !attached; i++) {
      try {
        const chooserP = tab.playwright.waitForEvent("filechooser", {timeoutMs: 20000});
        if (i % 2 === 0) await cdp.send("Runtime.evaluate", {expression: `(document.querySelector('[role="dialog"] input[data-testid="fileInput"]') || document.querySelector('input[data-testid="fileInput"]')).click()`, userGesture: true}, {timeoutMs: 20000});
        else {
          const r = await ev(`(() => { const b = document.querySelector('[aria-label="Add photos or video"]') || (document.querySelector('[role="dialog"] input[data-testid="fileInput"]') || document.querySelector('input[data-testid="fileInput"]'))?.closest('[role="button"]'); if (!b) return null; const q = b.getBoundingClientRect(); return {x: q.x + q.width / 2, y: q.y + q.height / 2}; })()`);
          if (!r) throw new Error("media button not found");
          for (const type of ["mousePressed", "mouseReleased"]) await cdp.send("Input.dispatchMouseEvent", {type, x: r.x, y: r.y, button: "left", clickCount: 1}, {timeoutMs: 20000});
        }
        const chooser = await chooserP;
        await chooser.setFiles([MEDIA], {timeoutMs: 60000});
        attached = true; log.push(`chooser ok (way ${i % 2})`);
      } catch (e) { log.push(`attach ${i + 1}: ${String(e.message).slice(0, 120)}`); await sleep(2500); }
    }
    if (!attached) throw new Error("could not attach the video");
    if (MEDIA) await until("media attached", `!!document.querySelector('[data-testid="attachments"]')`, 90000);

    // CAPTION GUARD. X's new composer shows line breaks on screen that it may not send, so the only trustworthy check is the
    // CreateTweet request itself. A hook on fetch/XHR reads tweet_text: in a real run it lets the request through only if the text
    // matches the caption line for line, otherwise it blocks it (nothing is posted) and the next typing method is tried. Dry runs
    // always block. In probe tests, Playwright fill, paste, type+Enter and beforeinput keep breaks; execCommand loses them.
    const canon = t => String(t ?? "").replace(/\r/g, "").split("\n").map(l => l.replace(/[ \t ]+/g, " ").trim()).join("\n").trim();
    const WANT = canon(TYPE_TEXT);
    await ev(`(() => { const canon = ${canon.toString()}; const want = ${JSON.stringify(WANT)}; const wantNoLink = ${JSON.stringify(QUOTE_URL ? canon(CAPTION) : null)}; const quoteId = ${JSON.stringify(QUOTE_ID)}; const dry = ${DRY ? "true" : "false"}; const replyId = ${JSON.stringify(REPLY_ID)};
      window.__g = {sent: false, bad: null, seen: null, reply: null, quote: null};
      const judge = body => { let t = null, rid = null; try { const v = JSON.parse(body).variables || {}; t = v.tweet_text ?? v.text ?? null; rid = v.reply?.in_reply_to_tweet_id ?? null; window.__g.quote = v.attachment_url ?? null; } catch (e) {} if (t != null || window.__g.seen == null) { window.__g.seen = t; window.__g.reply = rid; } const textOk = t != null && (canon(t) === want || (quoteId && canon(t) === wantNoLink && String(window.__g.quote || "").includes(quoteId))); window.__g.textOk = textOk; const ok = !dry && textOk && (replyId ? rid === replyId : rid == null); if (ok) window.__g.sent = true; else window.__g.bad = t != null && replyId && rid !== replyId ? "wrong reply target: " + rid : String(t); return ok; };
      if (!window.__guarded) { window.__guarded = true;
        const of = window.fetch; window.fetch = function (u, o) { if (/Create[A-Za-z]*Tweet/.test(String(u && u.url || u)) || (dry && String(u && u.url || u).includes('/graphql/') && String((o && o.method) || (u && u.method) || "GET").toUpperCase() === "POST")) { if (!judge(o && o.body)) return Promise.reject(new Error('caption guard')); } return of.apply(this, arguments); };
        const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; this.__m = m; return oo.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function (b) { if ((/Create[A-Za-z]*Tweet/.test(String(this.__u)) || (dry && String(this.__u).includes('/graphql/') && String(this.__m || "").toUpperCase() === "POST")) && !judge(b)) return; return os.apply(this, arguments); }; }
      return true; })()`);
    const box = `document.querySelector('[data-testid="tweetTextarea_0"]')`;
    const lines = TYPE_TEXT.split("\n");
    const loc = () => tab.playwright.locator('[data-testid="tweetTextarea_0"]').first();
    const clear = () => ev(`(() => { const b = ${box}; if (!b) return false; b.focus(); document.execCommand("selectAll"); document.execCommand("delete"); return true; })()`);
    const ways = [
      ["fill", () => loc().fill(TYPE_TEXT, {timeoutMs: 30000})],
      ["paste", () => ev(`(() => { const b = ${box}; b.focus(); const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(TYPE_TEXT)});
        b.dispatchEvent(new ClipboardEvent("paste", {clipboardData: dt, bubbles: true, cancelable: true})); return true; })()`)],
      ["beforeinput", async () => { for (let i = 0; i < lines.length; i++) { if (lines[i]) await ev(`document.execCommand("insertText", false, ${JSON.stringify(lines[i])})`); if (i < lines.length - 1) await ev(`(() => { const b = ${box}; b.dispatchEvent(new InputEvent("beforeinput", {inputType: "insertLineBreak", bubbles: true, cancelable: true})); return true; })()`); } }],
      ["type+Enter", async () => { for (let i = 0; i < lines.length; i++) { if (lines[i]) await loc().type(lines[i], {timeoutMs: 30000}); if (i < lines.length - 1) await loc().press("Enter", {timeoutMs: 15000}); } }],
    ];
    const postBtn = `(document.querySelector('[data-testid="tweetButtonInline"]') || document.querySelector('[data-testid="tweetButton"]'))`;
    let sent = false, matched = false;
    for (const [name, way] of ways) {
      try { await clear(); await way(); } catch (e) { log.push(`caption ${name}: ${String(e.message).slice(0, 90)}`); continue; }
      await sleep(800);
      // the Post button enables once the video finishes processing
      try { await until("upload finished", `(b => !!b && !b.disabled && b.getAttribute("aria-disabled") !== "true")(${postBtn})`, 240000); } catch (e) { log.push(`${name}: ${String(e.message).slice(0, 80)}`); continue; }
      // Undo: last check before the point of no return. The agent reads the marker to know whether it's too late.
      if (CANCEL && !DRY) { const nodeFs = await import("node:fs"); if (nodeFs.existsSync(CANCEL)) throw new Error("undone before Post"); nodeFs.writeFileSync(CANCEL + ".clicked", "1"); }
      await ev(`(window.__g.sent = false, window.__g.bad = null, window.__g.seen = null, window.__g.reply = null, ${postBtn}.click(), true)`);
      let g = null; for (let k = 0; k < 20; k++) { await sleep(500); g = await ev(`window.__g`).catch(() => null); if (g && (g.sent || g.bad != null)) break; }
      if (g?.sent) { sent = true; log.push(`caption ok (${name})${QUOTE_URL ? ", quote " + (g.quote ? "attached" : "as trailing link") : ""}, clicked Post`); break; }
      // NO REQUEST SEEN = UNKNOWN. X may have sent it through a path the guard didn't see (long posts once went out as
      // CreateNoteTweet and every "blocked" retry was a real post, 5 duplicates). Never click Post again in this run.
      if (!DRY && (g == null || (g.seen == null && g.bad == null))) { maybeSent = true; log.push(`caption ${name}: clicked Post, no guarded request seen, stopping (may have posted)`); throw new Error("clicked Post but the guard saw no request: may have posted, check X"); }
      const seen = canon(g?.seen);
      if (DRY && g?.seen != null && (seen === WANT || g.textOk) && (REPLY_ID ? g.reply === REPLY_ID : g.reply == null)) { matched = true; log.push(`caption ok (${name}), reply ${g.reply}, ${QUOTE_URL ? "quote " + (g.quote ? "attached as " + g.quote : "sent as a trailing link") + ", " : ""}dry run: post blocked`); break; }
      log.push(`caption ${name} blocked: ${JSON.stringify(String(g?.seen ?? g?.bad ?? "no request")).slice(0, 80)}`);
      await ev(`document.querySelector('[data-testid="toast"]') ? true : true`).catch(() => {});
    }
    if (DRY) {
      result = matched ? {ok: true, dryRun: true} : {ok: false, error: "caption never matched in a dry run", posted: false};
    } else if (!sent) {
      throw new Error("could not get X to send the caption exactly (guard blocked every attempt)");
    } else {
      log.push("clicked Post"); maybeSent = true;
      let url = null;
      for (let s = 0; s < 25 && !url; s++) { await sleep(1000); url = await ev(`document.querySelector('[data-testid="toast"] a[href*="/status/"]')?.href || null`).catch(() => null); }
      if (!url) { await sleep(4000); await open(HOME_POST, `!!document.querySelector('article [data-testid="tweetText"]')`, "profile after").catch(() => {}); url = await ev(FIND).catch(() => null); }
      result = {ok: true, url, ...(url ? {} : {note: "clicked Post but could not find the link"})};
    }
  }
} catch (e) {
  result = {ok: false, error: String(e?.message || e).slice(0, 400), posted: maybeSent || log.some(l => /clicked Post/.test(l)) ? null : false};
}
// close the worker tab this run opened (drops any half-written draft)
if (tab) { await (keepTab ? tab.goto(HOME_URL + "&" + (typeof RUN === "string" ? RUN : "")) : tab.close()).catch(() => {}); }
nodeRepl.write(JSON.stringify({...result, tabId: keepTab ? tab?.id : null, log}));
