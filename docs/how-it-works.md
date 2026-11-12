# How it works

Four parts, joined by a queue:

| Part | Where | Job |
|---|---|---|
| App | `site/worker/app.html` | One HTML file: swipe UI, sheets and live updates |
| API | `site/worker/index.js` | Cloudflare-style Worker with D1 (items, decisions, requests, threads, kv) and R2 (media) |
| Agent | `agent/agent.mjs` | Always-on process on your Mac. Polls the queue, posts, relays requests to T3 Code |
| Your T3 Code thread | T3 Code | Receives edit and batch requests, makes drafts |

The site can't reach your Mac, so the agent always calls out to the site. That means no open ports, and requests simply wait if the Mac is off. The app warns you if the agent hasn't checked in for 10 minutes.

## The four flows

**A draft reaches your phone.** Something writes `pieces/<id>/meta.json` and a media file. `feed publish` runs `sync.mjs`, which uploads media to R2 under a name containing the file's modified time, then upserts the item. A changed file gets a new version and returns to the feed tagged Updated. The agent also syncs every 10 minutes.

**You swipe to post.** The app records a decision and a `post` request, optionally with a schedule time and a quote link. The agent claims it, runs `post-x.mjs`, and reports `posted` or `failed` with a link. The activity sheet shows this, with Retry on failures. If your phone drops the connection, the app retries, and the Worker returns the first request instead of queueing a second post.

**You undo a post.** "Post now" waits 30 seconds before the agent can claim it, and the Undo toast stays for 90 seconds. Undo also works later, from the Activity sheet, while the post is queued, posting or failed. While a post runs, the agent checks its request every 3 seconds. On an undo it writes a cancel file and stops the poster. The post script checks that file right before it clicks Post and leaves a marker when it clicks. If the marker exists, it's too late: the run finishes and is recorded as posted. An undone post returns to the feed with the caption you wrote.

**Posts are spaced out.** With the post hold on, a due post stays `queued` and the agent moves its time to N minutes after your last post, so the app shows "Scheduled" with that time and Undo works as usual. The waiting posts form one queue, one gap apart: a newly chosen post goes to the end, and the agent pushes later ones back if two would share a slot. In the Activity sheet the waiting posts list the next one first, and you can drag them by the handle into a new order; the times stay put and the posts move between them (`POST /api/reorder`). The last post is the newest of the agent's posted ledger and your public X timeline, so a post made outside the app counts. The switch and the gap (5 minutes to 2 hours) are in the Activity sheet and stored in `kv`. See `agent/post-hold.mjs`.

**You post a thread.** "Make a thread" on any card lists the feed; you tick drafts and the thread opens in an editor where you change text, reorder, remove, add text-only posts, and post or schedule. Your agent can draft one too, with `feed.mjs thread put`. A thread is independent of its drafts: they stay their own cards with their own captions, tagged "In a thread", and posting or skipping a thread decides nothing for them. The agent posts each part as a reply to the one before and reports each link, so a failure or a restart resumes at the next part. A thread with parts already on X can't go back to a draft: Stop halts the rest and Retry finishes it.

**You ask for changes or a batch.** The app records an `edit` or `batch` request, with optional reference images. The agent claims it, downloads any images to `refs/<request id>/`, and POSTs to the T3 Code webhook. Your thread does the work, runs `ack.mjs <id> working`, publishes, then runs `ack.mjs <id> done "summary"`. A re-synced version also closes an open edit request.

**Live updates.** While visible, the app calls `GET /api/pulse` every 3 seconds. That returns a short signature of the feed and requests. Only when the feed signature changes does it fetch `/api/feed` and merge. This is polling, not push, because it needs no extra service and D1 stays the only source of truth.

Merge rules, so a card never changes under your thumb:
- The front card stays unless that same piece was re-rendered.
- Merges wait during a drag, swipe animation or open sheet, then run afterward.
- A card you just swiped stays out for 20 seconds, so a merge can't bring it back before the decision lands.

## Request statuses

`queued` → `claimed` → `sent` (relays) or `posting` (posts) → `working` → `done`, `posted`, `failed` or `canceled`. Scheduled and held posts wait as `queued` with a later run time.

A thread row is `draft`, `queued`, `posting`, `posted`, `failed`, `skipped` or `split` (deleted).

## API

Owner routes, for the signed-in app:

| Route | Purpose |
|---|---|
| `GET /api/feed` | Undecided items and drafted threads, agent status, open and failed counts, post hold settings, caption limit |
| `GET /api/pulse` | Change signatures, for live updates |
| `GET /api/activity` | Recent requests |
| `POST /api/decide` | `{id, action}`: `post` with caption, schedule and `quoteUrl`, `pass`, `edit` with a note and images, `undo` |
| `POST /api/thread` | `{action}`: `make` from `itemIds`, then by thread `id`: `save` parts, `post`, `undopost`, `skip`, `undoskip`, `defer`, `edit`, `split` (delete) |
| `POST /api/reorder` | `{ids}`: the waiting posts in their new order; they keep the same set of times |
| `POST /api/settings` | `{postHold, postHoldMin}`: the post hold switch and its gap in whole minutes, 5 to 240 |
| `POST /api/defer` | Move a card to the back, or undo that |
| `GET /api/skipped`, `POST /api/restore` | List skipped drafts, restore one |
| `POST /api/batch` | `{text, count, images}`: request new drafts |
| `POST /api/request` | `{id, action}`: cancel (undo), retry or reschedule |
| `POST /api/upload` | Upload a reference image |

Agent routes, using the agent token:

| Route | Purpose |
|---|---|
| `POST /api/agent/items` | Upsert items, each with an optional `quote` |
| `GET /api/agent/media-keys`, `PUT` or `GET /api/agent/media/<key>` | Media |
| `GET /api/agent/pending`, `POST /api/agent/claim` | Take work |
| `POST /api/agent/status` | Report progress |
| `GET /api/agent/stuck` | Requests left mid-flight by a crash |
| `GET /api/agent/scheduled`, `POST /api/agent/reschedule` | Future posts; the post hold moves them |
| `GET /api/agent/settings` | Post hold switch and gap |
| `GET /api/agent/request/<id>` | A request's status, polled while posting so an undo is noticed |
| `POST /api/agent/cancel` | Cancel a request, the same as Undo in the app |
| `POST /api/agent/thread`, `GET /api/agent/thread/<id>` | Create or replace a drafted thread, read one |
| `POST /api/agent/thread-part` | Record the link of a thread part that went out |
| `POST /api/agent/thread-split` | Delete a drafted thread, keeping each part's text as its draft's caption |
| `POST /api/agent/heartbeat` | Tell the app the agent is alive |

## Front-end map

`app.html` has no framework or build step beyond inlining into the Worker.

| Code | What it does |
|---|---|
| `load`, `render`, `cardEl` | First load and drawing the front and back cards |
| `renderGrid`, `pick`, `unpick` | Desktop grid (windows 900 px and wider): a tile action moves its item to the front and reuses the card actions |
| the `keydown` handlers | Arrow keys on desktop, ignored while typing, with a sheet open, with a modifier key, or on key repeat; Escape leaves a card opened from the grid |
| `attachDrag` | Pointer handling: left or right past 70 px skips or posts; up from the media past 80 px is later; vertical text drags still scroll |
| `advance`, `skip`, `later`, `undoTo` | Actions and undo |
| `pulse`, `mergeFeed` | Live updates |
| `openPost`, `openEdit`, `openAct`, `openSkipped` | Sheets |
| `makeThread`, `openThread` | The Make a thread sheet and the thread editor |
