# @frankie0736/dingtalk-notify

[![npm version](https://img.shields.io/npm/v/@frankie0736/dingtalk-notify.svg)](https://www.npmjs.com/package/@frankie0736/dingtalk-notify)
[![CI](https://github.com/frankie0736/dingtalk-notify-client/actions/workflows/ci.yml/badge.svg)](https://github.com/frankie0736/dingtalk-notify-client/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/npm/l/@frankie0736/dingtalk-notify.svg)](./LICENSE)

Zero-dependency DingTalk custom robot client. It signs the robot webhook locally with HMAC-SHA256, builds DingTalk's `text` / `markdown` payloads, injects `@` mentions, and posts directly to DingTalk.

- Pure ESM.
- Runs on Node.js 18+, Bun, and Cloudflare Workers / Edge.
- No runtime dependency on any notification server.
- Throws one `DingTalkError` type for validation, network, HTTP, and DingTalk business rejection failures.

Do not use this package in browsers. The DingTalk webhook and secret are credentials.

## Install

```bash
npm install @frankie0736/dingtalk-notify
# or
bun add @frankie0736/dingtalk-notify
```

## Quick Start

```ts
import { DingTalk } from '@frankie0736/dingtalk-notify';

const dt = new DingTalk({
  webhook: process.env.DINGTALK_WEBHOOK!,
  secret: process.env.DINGTALK_SECRET, // optional for keyword/IP-whitelist robots
});

await dt.text('Build #123 failed', { atMobiles: ['13800138000'] });

await dt.markdown(
  'Build #123',
  '### main failed\n- env: prod\n- [logs](https://example.com)',
);
```

## Mention Behavior

| Mode | Rich formatting | `atMobiles` triggers push? |
| --- | --- | --- |
| `text` | No | Yes. Real blue-badge `@` and device notification. |
| `markdown` | Yes | No. DingTalk can render the name in the card, but it does not push. |

This is a DingTalk platform behavior. The package preserves it instead of hiding it.

### `combo()`

When you need both a real push and rich detail, send a short `text` first and a `markdown` card second:

```ts
await dt.combo({
  alert: 'Build #123 failed. See detail.',
  title: 'Build #123',
  detail: '### main failed\n- env: prod\n- [logs](https://example.com)',
  atMobiles: ['13800138000'],
});
```

If the markdown leg fails after the text leg succeeds, the thrown `DingTalkError` has `comboLeg: 'markdown'` and `comboPartial.text`.

## API

```ts
new DingTalk({
  webhook: 'https://oapi.dingtalk.com/robot/send?access_token=...',
  secret: 'SEC...',       // optional
  timeoutMs: 10_000,      // default
  retries: 0,             // default; retries network failures and HTTP 5xx only
  fetch: customFetch,     // optional
  now: () => Date.now(),  // optional deterministic signing hook
});
```

Methods:

```ts
await dt.text(content, { atMobiles, atAll });
await dt.markdown(title, content, { atMobiles, atAll });
await dt.notify({ type: 'text', content, atMobiles, atAll });
await dt.notify({ type: 'markdown', title, content, atMobiles, atAll });
await dt.combo({ alert, title, detail, atMobiles, atAll });
```

Validation runs before any request:

- `content`: 1-20000 chars.
- markdown `title`: 1-200 chars.
- `atMobiles`: max 50, each matching `/^\+?\d{6,20}$/`.
- `atAll` and non-empty `atMobiles` are mutually exclusive.

## Result

`text` / `markdown` / `notify` resolve to DingTalk's direct verdict:

```ts
{
  httpStatus: 200,
  errcode: 0,
  errmsg: 'ok',
  rawBody: '{"errcode":0,"errmsg":"ok"}',
}
```

`combo()` resolves to `{ text: NotifyResult, markdown: NotifyResult }`.

## Error Handling

Every method throws `DingTalkError` on failure:

```ts
import { DingTalkError } from '@frankie0736/dingtalk-notify';

try {
  await dt.text('hi', { atMobiles: ['13800138000'] });
} catch (err) {
  if (err instanceof DingTalkError) {
    switch (err.kind) {
      case 'validation':
        break; // bad local input; no request sent
      case 'network':
        break; // fetch failed or timed out
      case 'http':
        break; // non-2xx; err.status and err.rawBody are available
      case 'rejected':
        break; // HTTP 2xx, but DingTalk returned errcode !== 0
    }
  }
}
```

| `kind` | Meaning | Useful fields |
| --- | --- | --- |
| `validation` | Local input rejected before sending | `message` |
| `network` | `fetch` threw or timed out | `cause` |
| `http` | DingTalk replied non-2xx | `status`, `errcode`, `errmsg`, `rawBody` |
| `rejected` | DingTalk replied 2xx with `errcode !== 0` | `errcode`, `errmsg`, `rawBody` |

`err.retryable` is true for `network` and HTTP 5xx failures only. DingTalk business rejections are not retried.

## DingTalk Limits

DingTalk custom robots are limited to 20 messages per minute per robot. This package does not add client-side throttling; keep rate control at your job queue, worker, or application boundary.

## Development

```bash
bun install
bun run check
bun run test
bun run build
```

Tests import `../dist/index.js`, so use `bun run test` after changing `src/`; it builds first.

## License

MIT (c) Frankie
