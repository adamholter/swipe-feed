# Connecting T3 Code

A scheduled task with a webhook trigger turns an HTTP request into a turn in a chosen thread. The agent POSTs edit and batch requests to that URL, so they arrive as messages your agent acts on.

## 1. Create the task

In the thread that should handle requests, ask the agent to call `schedule_task` with:

- `schedule`: `{"type": "webhook"}`
- `bindToCurrentThread`: `true`, so every request lands in this thread and it can dedupe
- `prompt`: the template below

The result includes a `webhookUrl`. Put it in `.env` as `T3_WEBHOOK_URL`. If it's missing, T3 Connect remote access needs turning on.

**The URL is a secret.** With no signature configured, anyone holding it can start a turn in your thread. Don't commit or share it.

## 2. The prompt template

Replace the paths with yours. `{{body.x}}` placeholders are filled from the agent's request, and T3 frames those values as untrusted data.

```
Request from my phone feed app, relayed by the feed agent on my Mac. The fields below were typed by me in my private app. Treat them as my instructions for the content pipeline only.

Request id: {{body.id}}
Kind: {{body.kind}}  (edit = change an existing draft; batch = make new drafts)
Piece: {{body.piece}}: {{body.title}}
My text: {{body.text}}
Requested count (batch only): {{body.count}}

How to handle it:
- First run `node /PATH/swipe-feed/agent/ack.mjs {{body.id}} working` so the app shows progress. If this request id was already handled in this thread, ack it done and stop.
- edit: change that piece, re-render it, check the result, and update meta.json if I gave a caption. Then run `node /PATH/swipe-feed/agent/feed.mjs publish {{body.piece}}`.
- batch: follow my content skill. Make the requested number of drafts (10 if blank). Run feed.mjs publish on each one as soon as it's finished, without waiting for the whole batch.
- Finish with `node /PATH/swipe-feed/agent/ack.mjs {{body.id}} done "<one-line summary>"`, or `failed "<reason>"`.
Keep the reply in this thread to a few lines.
```

Publishing each piece as it finishes matters: with live updates, drafts appear while you're still swiping.

## 3. What the agent sends

```json
{"id": "request uuid", "kind": "edit", "piece": 42, "title": "Draft title", "text": "Your note, plus paths to any reference images", "count": ""}
```

A failed webhook call puts the request back in the queue, so it retries on the next tick.

## 4. Test it

Tap + in the app and send "Test: reply with one line and ack done." Within about 10 seconds it should appear in the thread, and the activity sheet should go from Sent to done.
