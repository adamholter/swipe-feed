# Swipe Feed

A phone app for reviewing drafted posts. An AI agent makes drafts, you swipe, and your T3 Code thread handles anything you send back.

- **Swipe right:** post now or schedule, with your caption edits. Add an X post link to make it a quote post.
- **Swipe left:** skip. Skipped drafts can be restored.
- **Swipe up:** later.
- **Pencil:** send a change request to your T3 Code thread, with reference images if you like.
- **Plus:** ask your thread for a new batch.
- **Make a thread:** tick several drafts, then edit, reorder and post them as one X thread.
- **Undo:** works until the Post button is clicked on X, even while the agent is posting.

On a desktop browser there is also a grid view of every draft, and the arrow keys work: left skips, right posts, up is later, down is edit.

Posts you choose are spaced out by default: each waits until 30 minutes after your last one. The switch and the gap are at the top of the Activity sheet.

New drafts appear in the open app within about 3 seconds, with no reload. The app posts nothing itself: an always-on agent on your Mac does that, and only after you swipe.

```
 Phone app  <-->  Worker + D1 + R2  <-->  Agent on your Mac  --webhook-->  T3 Code thread
                                               |                               |
                                         Codex + Chrome                 makes drafts, runs
                                         posts to X, LinkedIn           feed publish and ack.mjs
```

This repo has the interface and the T3 Code connection. It doesn't include any idea or content pipeline: you bring your own, and anything that produces a media file and a `meta.json` works. `skills/what-works-on-x` is a general starting point.

## Setup

You need Node 22+, ffmpeg for video thumbnails, T3 Code, and a host for the Worker. Posting also needs Codex with its Chrome browser plugin, signed in to X in that Chrome.

1. **Deploy the site.** See [docs/hosting.md](docs/hosting.md).
2. **Configure.** `cp .env.example .env` and fill it in.
3. **Connect T3 Code.** Create the webhook task in [docs/t3-code.md](docs/t3-code.md) and put its URL in `.env`.
4. **Try it.** `node agent/sync.mjs` puts the example draft in the app.
5. **Run the agent.** `node agent/agent.mjs`, then keep it alive with `launchd/com.example.swipe-feed-agent.plist.example`.
6. **Test posting without posting.** `node agent/post-x.mjs /path/to/file.png caption.txt --dry-run` does everything except the final click. Read [docs/posting-agents.md](docs/posting-agents.md) first.

## Making a draft

```
node agent/feed.mjs new my-idea --batch first-batch   # makes pieces/001-my-idea/
# put your file in output/, fill in meta.json
node agent/feed.mjs publish 001
```

`meta.json`:

```json
{
  "title": "Short label for you",
  "caption": "The caption you'd post. It's editable in the app.",
  "alts": ["An alternative caption, shown as a chip"],
  "numbers": "Optional notes, under More",
  "source": "Optional source, under More",
  "kind": "video",
  "aspect": 1,
  "media": "output/video.mp4",
  "quote": {"url": "https://x.com/someone/status/123", "handle": "someone", "name": "Some One", "text": "The quoted post's text"}
}
```

`kind` is `video` or `still`. `aspect` is width divided by height. `quote` is optional: it makes the draft a quote post of that X post, and the app shows the quoted text in the post sheet. Copy `text` word for word. `"quote": null` removes it.

## Drafting a thread

A thread is its own card, built from drafts that are already in the app. The drafts stay their own cards too.

```
node agent/feed.mjs thread put launch-thread thread.json
node agent/feed.mjs thread get launch-thread     # prints it back, with any edits made in the app
```

`thread.json`:

```json
{
  "title": "Short label for you",
  "parts": [
    {"num": 1, "text": "First post, with draft 001's media"},
    {"text": "A text-only post"},
    {"num": 2, "text": "Last post, with draft 002's media"}
  ]
}
```

`put` with the same id replaces a thread that is still a draft. A part naming a draft that isn't in the app yet is left out and reported. Threads don't carry quotes.

## Tests

```
cd site && npm run build && cd ..
node test/worker.test.mjs    # the Worker on an in-memory database, in both AUTH_MODEs
node test/agent.test.mjs     # post hold timing and stopping a run
node test/ui.test.mjs        # headless browser checks; needs Playwright (npm i -D playwright, or set PLAYWRIGHT=/path/to/playwright/index.mjs)
```

The tests use made-up data, open no window and post nothing.

## Docs

- [How it works](docs/how-it-works.md): the data flow, API and front end
- [T3 Code connection](docs/t3-code.md): the webhook task and its prompt
- [Posting agents](docs/posting-agents.md): the prompts and hard-won safety rules
- [Hosting](docs/hosting.md): ChatGPT Sites or Cloudflare, and auth
