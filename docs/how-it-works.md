# How it works

Four parts, joined by a queue:

| Part | Where | Job |
|---|---|---|
| App | `site/worker/app.html` | One HTML file: swipe UI, sheets and live updates |
| API | `site/worker/index.js` | Cloudflare-style Worker with D1 (items, decisions, requests, kv) and R2 (media) |
| Agent | `agent/agent.mjs` | Always-on process on your Mac. Polls the queue, posts, relays requests to T3 Code |
| Your T3 Code thread | T3 Code | Receives edit and batch requests, makes drafts |

The site can't reach your Mac, so the agent always calls out to the site. That means no open ports, and requests simply wait if the Mac is off. The app warns you if the agent hasn't checked in for 10 minutes.

## The four flows

**A draft reaches your phone.** Something writes `pieces/<id>/meta.json` and a media file. `feed publish` runs `sync.mjs`, which uploads media to R2 under a name containing the file's modified time, then upserts the item. A changed file gets a new version and returns to the feed tagged Updated. The agent also syncs every 10 minutes.

**You swipe to post.** The app records a decision and a `post` request, optionally with a schedule time. The agent claims it, runs `post-x.mjs`, and reports `posted` or `failed` with a link. The activity sheet shows this, with Retry on failures.

**You ask for changes or a batch.** The app records an `edit` or `batch` request, with optional reference images. The agent claims it, downloads any images to `refs/<request id>/`, and POSTs to the T3 Code webhook. Your thread does the work, runs `ack.mjs <id> working`, publishes, then runs `ack.mjs <id> done "summary"`. A re-synced version also closes an open edit request.

**Live updates.** While visible, the app calls `GET /api/pulse` every 3 seconds. That returns a short signature of the feed and requests. Only when the feed signature changes does it fetch `/api/feed` and merge. This is polling, not push, because it needs no extra service and D1 stays the only source of truth.

Merge rules, so a card never changes under your thumb:
- The front card stays unless that same piece was re-rendered.
- Merges wait during a drag, swipe animation or open sheet, then run afterward.
- A card you just swiped stays out for 20 seconds, so a merge can't bring it back before the decision lands.

## Request statuses

`queued` → `claimed` → `sent` (relays) or `posting` (posts) → `working` → `done`, `posted`, `failed` or `canceled`. Scheduled posts wait as `scheduled`.

## API

Owner routes, for the signed-in app:

| Route | Purpose |
|---|---|
| `GET /api/feed` | Undecided items, agent status, open and failed counts |
| `GET /api/pulse` | Change signatures, for live updates |
| `GET /api/activity` | Recent requests |
| `POST /api/decide` | `{id, action}`: `post` with caption and schedule, `pass`, `edit` with a note and images, `undo` |
| `POST /api/defer` | Move a card to the back, or undo that |
| `GET /api/skipped`, `POST /api/restore` | List skipped drafts, restore one |
| `POST /api/batch` | `{text, count, images}`: request new drafts |
| `POST /api/request` | `{id, action}`: cancel, retry or reschedule |
| `POST /api/upload` | Upload a reference image |

Agent routes, using the agent token:

| Route | Purpose |
|---|---|
| `POST /api/agent/items` | Upsert items |
| `GET /api/agent/media-keys`, `PUT` or `GET /api/agent/media/<key>` | Media |
| `GET /api/agent/pending`, `POST /api/agent/claim` | Take work |
| `POST /api/agent/status` | Report progress |
| `GET /api/agent/stuck` | Requests left mid-flight by a crash |
| `GET /api/agent/scheduled`, `POST /api/agent/reschedule` | Future posts |
| `POST /api/agent/heartbeat` | Tell the app the agent is alive |

## Front-end map

`app.html` has no framework or build step beyond inlining into the Worker.

| Code | What it does |
|---|---|
| `load`, `render`, `cardEl` | First load and drawing the front and back cards |
| `attachDrag` | Pointer handling: left or right past 70 px skips or posts; up from the media past 80 px is later; vertical text drags still scroll |
| `advance`, `skip`, `later`, `undoTo` | Actions and undo |
| `pulse`, `mergeFeed` | Live updates |
| `openPost`, `openEdit`, `openAct`, `openSkipped` | Sheets |
