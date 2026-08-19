# Cloudflare proxy worker — jobboard-proxy

Proxy through which Azure Functions scrape job boards (JobsDB, CTgoodjobs, Indeed, OfferToday).

## Setup

1. `npm install`
2. Create the KV namespace and copy its id into `wrangler.jsonc`:

   ```bash
   npx wrangler kv namespace create JOBBOARD_KV
   ```

   Paste the returned `id` (and `preview_id`) into `wrangler.jsonc`.

3. (Optional) Restrict callers by origin:

   ```bash
   npx wrangler secret put ALLOWED_ORIGINS   # e.g. https://jobsautomation.azurewebsites.net
   ```

## Local dev

```bash
npm run dev
# curl "http://localhost:8787/jobsdb?keyword=web%20developer&page=1"
```

## Deploy

```bash
npm run deploy
```

## Request / Response contract

`GET /<board>?keyword=<kw>&page=<n>&countryCode=<hk>`

- `board`: `jobsdb` | `ctgoodjobs` | `indeed` | `offertoday`
- `countryCode`: optional 2-letter code (affects Indeed locale)

**200** `{ ok: true, html: "<page HTML>", cached?: true }`
**4xx/5xx** `{ ok: false, error: "blocked"|"rate_limited"|"challenge"|"timeout"|"not_found"|"upstream"|"missing_keyword"|"method_not_allowed"|"forbidden_origin", retryAfter?: number }`

Azure Functions should honour `retryAfter` (seconds) before retrying the same board.
