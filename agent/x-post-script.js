// Runs inside Codex's node_repl (trusted browser service). post-x.mjs fills in the MEDIA, CAPTION, DRY and CLIENT placeholders below.
// Uses raw CDP (Runtime.evaluate) plus locator typing because Playwright-style locators time out on X's huge DOM.
const MEDIA = __MEDIA__, CAPTION = __CAPTION__, DRY = __DRY__, CLIENT = __CLIENT__, TABID = __TABID__, HANDLE = __HANDLE__;
const log = []; let result, tab, keepTab = false, maybeSent = false;
const HOME_URL = `https://x.com/${HANDLE}?feedposter=1`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// keep the poster group collapsed so it never takes space in your tab strip (best effort)
const collapse = async () => { try { const mg = await chrome.capabilities.get("management"); const ts = await mg.tabs.query({url: "*://x.com/*"});
  for (const t of ts.filter(t => String(t.url).includes("feedposter=1"))) {
    let gid = t.groupId; if (gid == null || gid < 0) gid = await mg.tabs.group({tabIds: [t.id]});
    await mg.tabGroups.update(gid, {title: "📣 Feed poster", color: "grey", collapsed: true}); } } catch (e) { log.push(`group: ${String(e.message).slice(0, 80)}`); } };
const norm = s => String(s || "").replace(/\s+/g, " ").trim();
try {
  if (globalThis.agent?.browsers == null) { const { setupBrowserRuntime } = await import(CLIENT); globalThis.agent = await setupBrowserRuntime(); }
  if (globalThis.chrome == null) globalThis.chrome = await agent.browsers.get("chrome");
  // the runtime refuses raw CDP until these docs have been read in this session
  for (const name of ["confirmations", "capabilities/tab/cdp"]) { try { await agent.documentation.get(name); } catch (e) { log.push(`doc ${name}: ${String(e.message).slice(0, 80)}`); } }
  // One permanent poster tab inside its own background agent tab group ("📣 Feed poster", URL marker feedposter=1).
  // Tab ids don't carry over between Codex runs (each run is a fresh browser runtime), so every run finds the tab by its
  // marker and claims it; claiming keeps it in its group. Only if it is missing does the run open one with tabs.new(),
  // which puts it in this session's agent group in the background. Never claim your own tabs, never one tab per post
  // (per-post groups synced to another machine and crashed its Chrome).
  // A fresh poster tab is a regular tab made with the management API inside one collapsed "📣 Feed poster" group, so later
  // runs can claim it again (agent tabs from tabs.new() can't be re-claimed: "Debugger unattached"), and the group is made
  // once, not per post. Falls back to an agent tab if the management API is unavailable.
  // Every run makes a fresh regular tab in the poster's hidden window (AppleScript; claimed tabs from earlier runs keep a
  // stale debugger: "Debugger unattached"), puts it in the window's "📣 Feed poster" group, then closes the old poster tabs.
  const {execFileSync} = await import("node:child_process");
  const osa = src => execFileSync("osascript", ["-e", src], {encoding: "utf8"}).trim();
  const RUN = "feedrun=" + Date.now();
  const newPosterTab = async () => {
    try {
      osa(`tell application "Google Chrome"\nset pid to missing value\nrepeat with w in windows\nrepeat with t in tabs of w\nif (URL of t) contains "feedposter=1" then set pid to (id of w)\nend repeat\nend repeat\nif pid is missing value then\nset nw to make new window\nset pid to (id of nw)\nend if\nmake new tab at end of tabs of (window id pid) with properties {URL:"${HOME_URL}&${RUN}"}\nset visible of (window id pid) to false\nend tell`);
      try { const mg = await chrome.capabilities.get("management"); const all = await mg.tabs.query({});
        const mine = all.find(t => String(t.url).includes(RUN)), grp = all.find(t => String(t.url).includes("feedposter=1") && !String(t.url).includes(RUN) && t.groupId > -1 && t.windowId === mine?.windowId);
        if (mine) { const gid = grp ? await mg.tabs.group({groupId: grp.groupId, tabIds: [mine.id]}) : await mg.tabs.group({tabIds: [mine.id]});
          await mg.tabGroups.update(gid, {title: "📣 Feed poster", color: "grey", collapsed: true}); }
      } catch (e) { log.push(`group: ${String(e.message).slice(0, 80)}`); }
      for (let k = 0; k < 15; k++) { await sleep(600);
        const u = (await chrome.user.openTabs()).find(t => String(t.url).includes(RUN));
        if (u) { const t = await chrome.user.claimTab(u); log.push("fresh poster tab"); return t; } }
      throw new Error("fresh poster tab not listed");
    } catch (e) { log.push(`fresh tab: ${String(e.message).slice(0, 100)}`); }
    try { await chrome.nameSession("📣 Feed poster"); } catch (e) {}
    const t = await chrome.tabs.new(); log.push("opened an agent poster tab"); return t; };
  const closeOldPosterTabs = () => { try { osa(`tell application "Google Chrome"\nrepeat with w in windows\nrepeat with i from (count of tabs of w) to 1 by -1\nset u to URL of tab i of w\nif u contains "feedposter=1" and u does not contain "${RUN}" then close tab i of w\nend repeat\nend repeat\nend tell`); } catch (e) { log.push(`close old: ${String(e.message).slice(0, 60)}`); } };
  tab = await newPosterTab(); keepTab = true; closeOldPosterTabs();
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
    for (const a of [...document.querySelectorAll("article")].slice(0, 8)) {
      const t = a.querySelector('[data-testid="tweetText"]'), l = a.querySelector('a[href*="/status/"] time')?.closest("a");
      if (t && l && n(t.innerText).slice(0, 100) === cap) return "https://x.com" + l.getAttribute("href"); }
    return null; })()`;

  // never double-post: if one of the newest posts already has this exact caption, report it instead
  let existing = null;
  if (!DRY) {
    await open(`https://x.com/${HANDLE}`, `!!document.querySelector('article [data-testid="tweetText"]')`, "profile");
    await sleep(1500);
    existing = await ev(FIND);
  }
  if (existing) result = {ok: true, url: existing, note: "already posted"};
  else {
    // the home timeline composer (Draft.js) keeps line breaks; the compose/post popup editor drops them when X reads it
    await open("https://x.com/home", `!!(document.querySelector('[role="dialog"] [data-testid="tweetTextarea_0"]') || document.querySelector('[data-testid="tweetTextarea_0"]'))`, "composer");
    const signedIn = await ev(`document.body.innerText.includes("@${HANDLE}")`).catch(() => null);
    if (signedIn === false) throw new Error("NOT_LOGGED_IN as @" + HANDLE);

    // attach through the file-chooser flow; open the chooser with a user-gesture click (or a real mouse click on the media button)
    let attached = false;
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
    await until("media attached", `!!document.querySelector('[data-testid="attachments"]')`, 90000);

    // CAPTION GUARD. X's new composer shows line breaks on screen that it may not send, so the only trustworthy check is the
    // CreateTweet request itself. A hook on fetch/XHR reads tweet_text: in a real run it lets the request through only if the text
    // matches the caption line for line, otherwise it blocks it (nothing is posted) and the next typing method is tried. Dry runs
    // always block. Probe tests (Oct 27): Playwright fill, paste, type+Enter and beforeinput keep breaks; execCommand loses them.
    const canon = t => String(t ?? "").replace(/\r/g, "").split("\n").map(l => l.replace(/[ \t ]+/g, " ").trim()).join("\n").trim();
    const WANT = canon(CAPTION);
    await ev(`(() => { const canon = ${canon.toString()}; const want = ${JSON.stringify(WANT)}; const dry = ${DRY ? "true" : "false"};
      window.__g = {sent: false, bad: null, seen: null};
      const judge = body => { let t = null; try { const v = JSON.parse(body).variables || {}; t = v.tweet_text ?? v.text ?? null; } catch (e) {} window.__g.seen = t; const ok = !dry && t != null && canon(t) === want; if (ok) window.__g.sent = true; else window.__g.bad = String(t); return ok; };
      if (!window.__guarded) { window.__guarded = true;
        const of = window.fetch; window.fetch = function (u, o) { if (/Create[A-Za-z]*Tweet/.test(String(u && u.url || u)) || (dry && String(u && u.url || u).includes('/graphql/') && String((o && o.method) || (u && u.method) || "GET").toUpperCase() === "POST")) { if (!judge(o && o.body)) return Promise.reject(new Error('caption guard')); } return of.apply(this, arguments); };
        const oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (m, u) { this.__u = u; this.__m = m; return oo.apply(this, arguments); };
        XMLHttpRequest.prototype.send = function (b) { if ((/Create[A-Za-z]*Tweet/.test(String(this.__u)) || (dry && String(this.__u).includes('/graphql/') && String(this.__m || "").toUpperCase() === "POST")) && !judge(b)) return; return os.apply(this, arguments); }; }
      return true; })()`);
    const box = `document.querySelector('[data-testid="tweetTextarea_0"]')`;
    const lines = CAPTION.split("\n");
    const loc = () => tab.playwright.locator('[data-testid="tweetTextarea_0"]').first();
    const clear = () => ev(`(() => { const b = ${box}; if (!b) return false; b.focus(); document.execCommand("selectAll"); document.execCommand("delete"); return true; })()`);
    const ways = [
      ["fill", () => loc().fill(CAPTION, {timeoutMs: 30000})],
      ["paste", () => ev(`(() => { const b = ${box}; b.focus(); const dt = new DataTransfer(); dt.setData("text/plain", ${JSON.stringify(CAPTION)});
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
      await ev(`(window.__g.sent = false, window.__g.bad = null, window.__g.seen = null, ${postBtn}.click(), true)`);
      let g = null; for (let k = 0; k < 20; k++) { await sleep(500); g = await ev(`window.__g`).catch(() => null); if (g && (g.sent || g.bad != null)) break; }
      if (g?.sent) { sent = true; log.push(`caption ok (${name}), clicked Post`); break; }
      // NO REQUEST SEEN = UNKNOWN. X may have sent it through a path the guard didn't see (Oct 30: long posts went out as
      // CreateNoteTweet and every "blocked" retry was a real post, 5 duplicates). Never click Post again in this run.
      if (!DRY && (g == null || (g.seen == null && g.bad == null))) { maybeSent = true; log.push(`caption ${name}: clicked Post, no guarded request seen, stopping (may have posted)`); throw new Error("clicked Post but the guard saw no request: may have posted, check X"); }
      const seen = canon(g?.seen);
      if (DRY && g?.seen != null && seen === WANT) { matched = true; log.push(`caption ok (${name}), dry run: post blocked`); break; }
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
      if (!url) { await sleep(4000); await open(`https://x.com/${HANDLE}`, `!!document.querySelector('article [data-testid="tweetText"]')`, "profile after").catch(() => {}); url = await ev(FIND).catch(() => null); }
      result = {ok: true, url, ...(url ? {} : {note: "clicked Post but could not find the link"})};
    }
  }
} catch (e) {
  result = {ok: false, error: String(e?.message || e).slice(0, 400), posted: maybeSent || log.some(l => /clicked Post/.test(l)) ? null : false};
}
// park the permanent tab back on the profile (drops any half-written draft); only close a tab we opened ourselves
if (tab) { await (keepTab ? tab.goto(HOME_URL + "&" + (typeof RUN === "string" ? RUN : "")) : tab.close()).catch(() => {}); if (keepTab) await collapse(); }
nodeRepl.write(JSON.stringify({...result, tabId: keepTab ? tab?.id : null, log}));
