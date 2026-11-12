# Posting agents

X has no affordable API for this, so posting runs through Codex driving your real, signed-in Chrome. It's the fragile part of the system, and most of the code here exists because something went wrong once.

| File | Role |
|---|---|
| `agent/post-x.mjs` | Builds the prompts, runs Codex, returns one JSON line: `{ok, url?, error?, posted?}` |
| `agent/x-post-script.js` | Fast path: a script Codex runs inside its browser runtime |
| `agent/linkedin-post.mjs` | Optional cross-post, separate from X |
| `agent/agent.mjs` | Retries, duplicate protection, undo, threads and the post lane |
| `agent/post-hold.mjs` | Spacing between posts |

This setup is macOS-only, because it lists and closes Chrome tabs with AppleScript. It assumes Codex's Chrome browser plugin and reads the plugin's path from `~/.codex/config.toml`. Codex runs with approvals and sandbox off, so treat this as trusted automation on your own machine. Plugin APIs change, so expect to adapt it.

## The two attempts

**1. Scripted.** A cheap model at low effort runs one line that loads a prepared file:

> Run the one line of JavaScript below EXACTLY as written (it loads a prepared script file), in one call to the Node REPL js tool with timeout_ms 900000. Do not rewrite it. The script opens its own tab, checks the profile so it never double-posts, attaches the video, types the caption, clicks Post, closes its tab and prints one JSON line. If the js tool call itself errors, call it once more with the same code. Your final answer must be only the JSON line the script printed.

Models used to retype the whole script and sometimes mangled it, which is why it's one line.

**2. Agentic fallback.** If the script fails and nothing was posted, the model does it with browser tools, at medium effort, for up to 30 minutes. The full prompt is `agentPrompt` in `post-x.mjs`. Its essentials:

> This setup is known to work. Get this post published. An earlier scripted attempt just failed with: [error]. That failure is not a reason to stop, and neither is any single error you hit.

The encouragement matters: without it, models tended to give up on the first transient error.

Its rules:
- Check the newest ~8 posts on the profile first. If one starts with the same 100 characters, don't post; return its URL.
- Click Post at most once, ever. If anything is unclear afterward, check the profile and report.
- Use only the poster's own tab, and never touch or show your tabs or windows.
- Enter the caption exactly, keeping line breaks.
- Right before clicking Post, check the cancel file. If it exists, you undid the post: stop.

## Flags

`node agent/post-x.mjs <media|none> <captionFile> [--dry-run] [--reply-to <postUrl>] [--quote <postUrl>] [--anchor] [--cancel-file <path>]`

- `--reply-to` posts a thread part. The caption is typed into the parent post's own reply box, and the send check refuses any request whose reply target isn't that post, so a part can't go out on its own.
- `--quote` types the link on its own last line, which X turns into the quoted card. The send check accepts the link either still in the text or moved to `attachment_url`. Duplicate checks compare the caption alone.
- `--anchor` is passed for threads, so every part shares one tab group.
- `--cancel-file` is how undo reaches the script. See below.
- `none` as the media makes a text-only post.

## Output contract

The final answer is one JSON line. `posted` drives every retry decision:

| Result | Meaning | What the agent does |
|---|---|---|
| `{"ok": true, "url": "..."}` | Posted | Marks posted, queues LinkedIn |
| `{"ok": false, "posted": false}` | Definitely not posted | Retries with backoff, up to 14 attempts over about 10 hours |
| `{"ok": false, "posted": null}` or `true` | May have posted | Stops and tells you to check X. Never retries |

## Lessons built into the code

- **Duplicates are worse than failures.** Every caption that went out or may have gone out is recorded in a ledger for 14 days, and a repeat is refused. This was added after five duplicate posts.
- **Check what was sent, not what's on screen.** X's composer can show line breaks that it then drops. `x-post-script.js` hooks the outgoing request and blocks it unless the text matches the caption line by line, trying the next typing method if not.
- **Typing methods differ by site.** On X, `document.execCommand` loses line breaks. On LinkedIn, Playwright's `fill()` looks right in the editor but publishes blank lines as single breaks, so it types line by line and checks the paragraphs.
- **No windows, and nothing left open.** Each run opens one background tab in Codex's own agent tab group and closes it when it ends, so no window is created and focus never moves. A thread parks one extra tab so its parts share a group, and the agent closes it when the thread stops. Chrome Sync copies tab groups to your other machines, and heavy group churn once crashed Chrome on one, so watch for that if you post very often.
- **Fresh tab per run.** Tabs claimed from earlier runs can hold a stale debugger.
- **Undo needs a point of no return.** The agent polls the request while posting. On an undo it writes the cancel file, waits a second, and stops the poster, which also stops Codex. The script checks the file right before clicking Post and writes `<file>.clicked` when it clicks. If that marker exists the agent lets the run finish and records it. A stopped run reports nothing and adds nothing to the ledger.
- **A thread is a chain of single posts.** Each part goes through the same one-way Post click and ledger as any post. Progress is saved after every part in `thread-<request id>.json` in the log folder, so a retry resumes at the next part and never reposts one. A part with an unknown outcome or no link stops the thread, since the next reply has no safe parent.
- **Spacing is a hold, not a schedule.** `post-hold.mjs` keeps a due post queued until N minutes after your last one. It reads your public timeline through api.fxtwitter.com, a third-party service that sees your handle and sometimes fails; set `POST_HOLD_TIMELINE=0` in `.env` to use the ledger alone. Retries wait too, except a thread that already has parts up. Any error in the check lets the post through. `touch post-hold.off` in the log folder turns it off without the app.
- **Posts get their own lane.** A post can take 15+ minutes, and relays and heartbeats shouldn't wait for it.
- **Cross-posting can't break X.** LinkedIn has its own queue, session and log, every call is caught, and it never retries anything that may have posted. A thread cross-posts its first post only.

## Scheduled and stuck posts

Schedule times are rejected if more than 60 days out, after a phone date picker saved some in the wrong year. A post left mid-flight by a restart is marked failed with "Check X before retrying", rather than retried blindly.
