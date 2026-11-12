# Hosting

The site is a Worker with a D1 database named `DB` and an R2 bucket named `BUCKET`. Build it from `site/`:

```
npm run build      # inlines app.html into dist/server/index.js
npm run validate
```

Migrations are in `site/drizzle/`. Apply new ones when you update: `0003_threads.sql` adds threads. Until it's applied, the feed and posting keep working and only thread actions report that it's missing.

Optional setting: `CAPTION_MAX`, the longest caption the app accepts. The default is 25,000, X Premium's limit. Set it to 280 for an account without Premium. The post sheet shows a count past 280 either way.

## Auth

The Worker refuses to run until `AUTH_MODE` is set, because it trusts identity headers from the platform in front of it. **Without that platform in front, anyone could fake those headers.** Set `OWNER_EMAIL` as well.

| AUTH_MODE | Owner is identified by | Agent is identified by |
|---|---|---|
| `sites` | ChatGPT Sites' signed-in owner header | Sites service token, checked by Sites |
| `cloudflare-access` | Cloudflare Access's email header | `Authorization: Bearer AGENT_TOKEN` |

Media under `/m/` needs the same auth.

## Option A: ChatGPT Sites

Copy `site/.openai/hosting.example.json` to `hosting.json`, then deploy with the Sites plugin in Codex. Keep the audience owner-only. Set `AUTH_MODE=sites` and `OWNER_EMAIL` in the Site's environment. Create a Sites service token for `FEED_TOKEN`, and use `AUTH_MODE=sites` in `.env`.

## Option B: Cloudflare Workers

1. Copy `site/wrangler.toml.example` to `wrangler.toml` and create the D1 database and R2 bucket.
2. `wrangler d1 migrations apply swipe-feed`, then `wrangler secret put AGENT_TOKEN`.
3. Build and `wrangler deploy`.
4. **Protect the hostname with Cloudflare Access**, allowing only your email, and add a bypass for `/api/agent/*`.
5. In `.env`, set `AUTH_MODE=cloudflare-access` and `FEED_TOKEN` to the same token.

This option has been tested only against a local stand-in for the Worker, not on real Cloudflare or Access. Check that a logged-out browser gets refused before trusting it.
