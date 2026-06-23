# @frankie0736/dingtalk-notify

Thin, zero-dependency client for the [DingTalk Notification Server](https://github.com/frankie0736/dingtalk-notify-client). Send DingTalk group-chat notifications over a single authenticated endpoint — no HMAC signing, no `@mobile` injection, no per-service boilerplate.

The server handles signing, encryption, and auditing. This package handles the one thing every caller would otherwise re-implement: a correct `fetch` with the right headers, body shape, and — crucially — the "HTTP 200 but DingTalk rejected it" failure that a naive wrapper silently treats as success.

- **Pure ESM**, zero runtime dependencies.
- Runs on **Node.js 18+, Bun, and Cloudflare Workers / Edge** (anything with global `fetch`).
- **Throws on failure**, with a single `DingTalkError` whose `kind` tells you exactly what went wrong.

> Not for browsers: the bearer token must never ship to a frontend.

## Install

```bash
npm install @frankie0736/dingtalk-notify
# or
bun add @frankie0736/dingtalk-notify
```

## Quick start

```ts
import { DingTalk } from '@frankie0736/dingtalk-notify';

const dt = new DingTalk({ token: process.env.DINGTALK_TOKEN! }); // 'dnk_...'

// Plain text — atMobiles here fires a real @-push + device notification.
await dt.text('🔔 Build #123 failed', { atMobiles: ['13800138000'] });

// Markdown card — rich formatting (no push; see below).
await dt.markdown('Build #123', '### main 失败\n- env: prod\n- [logs](https://example.com)');
```

## `@`-mention behavior (a DingTalk platform quirk)

| Mode | Rich formatting | `atMobiles` triggers push? |
| --- | --- | --- |
| `text` | No | **Yes** — real blue-badge @ + device notification |
| `markdown` | Yes (lists, links, bold, code) | **No** — name renders in the card, but no push fires |

This asymmetry is a DingTalk limitation, not a choice of this library.

### `combo()` — push + rich content in one call

When you need both a reliable @-push **and** a rich card, send a short `text` (the actual notification) followed by a `markdown` card with the detail:

```ts
await dt.combo({
  alert: '🔔 Build #123 failed — see detail',  // short text, carries the @
  title: 'Build #123',
  detail: '### main 失败\n- env: prod\n- [logs](https://example.com)',
  atMobiles: ['13800138000'],
});
```

The `text` leg is sent first (it's the real push). If the `markdown` leg then fails, the thrown error carries `comboLeg: 'markdown'` and the already-sent text result on `comboPartial.text`.

## Error handling

Every method throws [`DingTalkError`](./src/errors.ts) on failure. Branch on `kind`:

```ts
import { DingTalk, DingTalkError } from '@frankie0736/dingtalk-notify';

try {
  await dt.text('hi', { atMobiles: ['13800138000'] });
} catch (err) {
  if (err instanceof DingTalkError) {
    switch (err.kind) {
      case 'validation': break; // bad input — no request was sent
      case 'network':    break; // fetch failed or timed out
      case 'http':       break; // non-2xx; err.status, err.serverError
      case 'rejected':   break; // HTTP 200 but DingTalk said no; err.errcode, err.errmsg, err.logId
    }
  }
}
```

| `kind` | Meaning | Useful fields |
| --- | --- | --- |
| `validation` | Input rejected client-side; **no request sent** | `message` |
| `network` | `fetch` threw or the request timed out | `cause` |
| `http` | Server replied non-2xx | `status`, `serverError`, `details`, `requestId` |
| `rejected` | HTTP 200 but `ok:false` (DingTalk rejected) | `errcode`, `errmsg`, `rawBody`, `logId`, `requestId` |

`err.retryable` is `true` for `network` failures and HTTP 5xx.

## Options

```ts
new DingTalk({
  token: 'dnk_...',                          // required, per-robot bearer token
  baseUrl: 'https://dingtalk-notify.210k.cc', // default
  timeoutMs: 10_000,                          // per-request, via AbortController
  retries: 0,                                 // retries network/timeout/5xx only; never 4xx or rejected
  fetch: customFetch,                         // optional; defaults to global fetch
  userAgent: '@frankie0736/dingtalk-notify',  // optional override
});
```

## Result shape

`text` / `markdown` / `notify` resolve to:

```ts
{
  logId: string;      // server audit-log id (lg_...); cross-reference in /admin/logs
  requestId: string;  // trace id (rq_...); also in server logs
  dingtalk: { httpStatus: number | null; errcode: number | null; errmsg: string | null };
}
```

`combo` resolves to `{ text: NotifyResult, markdown: NotifyResult }`.

> Field names are camelCase here; the server's wire format uses snake_case (`log_id`, `request_id`, `at_mobiles`). The SDK converts both ways for you.

## Development

```bash
bun install
bun run check   # typecheck
bun run test    # build + node:test
bun run build   # emit dist/
```

## License

MIT © Frankie
