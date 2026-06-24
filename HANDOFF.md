# HANDOFF - dingtalk-notify-client direct webhook rewrite

## Current State

The package has been rewritten from a notification-server wrapper into a direct DingTalk custom robot SDK.

Stable invariant:

- caller owns DingTalk `webhook` and optional `secret`
- package validates once at the boundary
- package builds DingTalk's wire body locally
- package signs locally with HMAC-SHA256 only when `secret` exists
- success is DingTalk's direct `errcode === 0`
- server-only concepts (`token`, `baseUrl`, `logId`, `requestId`, server envelopes) are gone

## Main Files

- `src/client.ts`: `DingTalk` class, signing, validation, body building, retry/timeout, response parsing
- `src/types.ts`: public direct-webhook API types
- `src/errors.ts`: single `DingTalkError` with `validation | network | http | rejected`
- `test/client.test.ts`: contract tests against built `dist/index.js`
- `README.md`: user-facing direct webhook docs
- `CLAUDE.md`: repo working contract for future agents

## Behavior

Constructor:

```ts
new DingTalk({
  webhook: 'https://oapi.dingtalk.com/robot/send?access_token=...',
  secret: 'SEC...', // optional for keyword/IP-whitelist robots
  timeoutMs: 10_000,
  retries: 0,
  fetch,
  now,
});
```

Methods:

- `text(content, { atMobiles, atAll })`
- `markdown(title, content, { atMobiles, atAll })`
- `notify({ type: 'text' | 'markdown', ... })`
- `combo({ alert, title, detail, atMobiles, atAll })`

Result:

```ts
{ httpStatus: number, errcode: number | null, errmsg: string | null, rawBody: string }
```

## Verification Already Run

```bash
bun run test
```

At the time this handoff was written, all 17 tests passed.

## Still Pending

Run full final gates before release:

```bash
bun run check
bun run test
bun run build
npm pack --dry-run
```

Release decisions still need user approval:

- whether to unpublish the already-published wrong `0.1.0`
- whether next release should be `0.2.0` or `1.0.0`
- when to push tags and publish through CI

Do not publish or unpublish without explicit user confirmation.
