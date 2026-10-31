# supporters

The latest Ko-fi supporters for every Sponsor dialog, as a looping strip of icons, names and how long ago they tipped. Amounts and messages are never stored or shown. A private tip appears as "Someone".

```html
<script type="module" src="https://supporters.mkpo.li/roll.js"></script>
<supporters-roll label="Recent supporters" anonymous="Someone"></supporters-roll>
```

The element stays hidden until the list loads, follows the nearest `lang` for relative times, and inherits `--sp-text`, `--sp-muted`, `--sp-soft` and `--sp-line` from the dialog. With reduced motion it shows a static list.

## Setup

```sh
bunx wrangler d1 create supporters          # put the id in wrangler.jsonc
bunx wrangler d1 migrations apply supporters --remote
bunx wrangler secret put KOFI_TOKEN         # Ko-fi → Settings → API → Webhooks → verification token
bunx wrangler deploy
```

Then set the Ko-fi webhook URL to `https://supporters.mkpo.li/kofi`. To hide a supporter:
`bunx wrangler d1 execute supporters --remote --command "UPDATE supporters SET hidden = 1 WHERE id = <id>"`.

## API

- `POST /kofi` — Ko-fi webhook. Checks the verification token, ignores repeated message ids, and keeps one row per supporter (keyed by email hash, or by name when Ko-fi sends no email).
- `GET /v1/supporters` — up to 30 supporters, newest first: `{ id, name, monthly, at, avatar }`. `name` is `null` for private tips. Cached for 5 minutes; a new tip clears the cache.
- `GET /v1/avatar/:id` — the supporter's Gravatar, fetched by the Worker so the email hash never reaches the browser.

The webhook format comes from third-party descriptions of Ko-fi's webhook, since Ko-fi's help centre blocks automated reading: [apis.io Ko-fi AsyncAPI](https://apis.io/asyncapis/ko-fi/ko-fi-asyncapi/), [NodeBB forum sample payload](https://community.nodebb.com/topic/17448/ko-fi-webhook-plugin-request) (both read 2026-10-31). Check the payload against a real test webhook from Ko-fi's settings page before relying on it.
