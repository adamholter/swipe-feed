# Swipe Feed

A phone app for reviewing drafted posts. An AI agent makes drafts, you swipe, and your T3 Code thread handles anything you send back.

- **Swipe right:** post now or schedule, with your caption edits.
- **Swipe left:** skip. Skipped drafts can be restored.
- **Swipe up:** later.
- **Pencil:** send a change request to your T3 Code thread.
- **Plus:** ask your thread for a new batch.

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
  "media": "output/video.mp4"
}
```

`kind` is `video` or `still`. `aspect` is width divided by height.

## Docs

- [How it works](docs/how-it-works.md): the data flow, API and front end
- [T3 Code connection](docs/t3-code.md): the webhook task and its prompt
- [Posting agents](docs/posting-agents.md): the prompts and hard-won safety rules
- [Hosting](docs/hosting.md): ChatGPT Sites or Cloudflare, and auth
