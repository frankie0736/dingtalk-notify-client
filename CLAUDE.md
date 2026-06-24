# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## What This Is

`@frankie0736/dingtalk-notify` is a zero-runtime-dependency, pure-ESM SDK for DingTalk custom robots.

The caller owns the DingTalk robot `webhook` and optional `secret`. This package validates local input, signs the webhook with DingTalk's HMAC-SHA256 algorithm when `secret` exists, builds DingTalk `text` / `markdown` bodies, injects mentions, and posts directly to `oapi.dingtalk.com`.

It has no runtime relationship with `dingtalk_notification_server`. That server is only a historical reference for the signing/body-building algorithm.

Do not reintroduce `token`, `baseUrl`, server envelopes, `logId`, or `requestId` into shared client logic. Those belong to the old notification-server wrapper architecture.

## Commands

```bash
bun install
bun run check     # tsc --noEmit (typechecks src only)
bun run test      # builds dist, then runs node:test
bun run build     # tsc -p tsconfig.build.json -> dist/ (.js + .d.ts only)
```

Run a single test:

```bash
bun run build && node --test --experimental-strip-types --test-name-pattern "combo" test/client.test.ts
```

## Non-Obvious Things

- Tests import the built output, not source. `test/client.test.ts` imports `../dist/index.js`, so `bun run test` must build first.
- Node 22.x needs `--experimental-strip-types` for the `.ts` test file; the script already includes it.
- Two tsconfigs are intentional. `tsconfig.json` is `noEmit` for `check`; `tsconfig.build.json` emits `dist/`.
- Source internal imports use `.js` specifiers under NodeNext ESM. Do not change them to extensionless or `.ts`.
- The public deterministic signing hook is `now?: () => number`; it exists so tests can assert the exact signed URL without patching global time.

## Architecture

The package is `src/client.ts` + `src/errors.ts` + `src/types.ts`, re-exported from `src/index.ts`.

`src/types.ts` is the public contract:

- `DingTalkOptions`: `{ webhook, secret?, timeoutMs?, retries?, fetch?, now? }`
- message inputs: `text`, `markdown`, and `notify` with camelCase `atMobiles` / `atAll`
- results: DingTalk's direct `{ httpStatus, errcode, errmsg, rawBody }`

`src/client.ts` owns the single validation and normalization boundary:

- `content`: 1-20000 chars
- markdown `title`: 1-200 chars
- mobile regex: `/^\+?\d{6,20}$/`
- `atMobiles`: max 50
- `atAll` and non-empty `atMobiles` are mutually exclusive

After validation, the client builds the DingTalk wire body:

- `text`: `{ msgtype: 'text', text: { content }, at }`
- `markdown`: `{ msgtype: 'markdown', markdown: { title, text }, at }`
- markdown mention rendering requires literal trailing `@<mobile> ` tokens in `markdown.text`

Only `text` messages trigger a real DingTalk `@` push. `markdown` can render names but does not push. `combo()` preserves this by sending `text` first, then `markdown`; if the second leg fails, the error includes `comboLeg: 'markdown'` and `comboPartial.text`.

## Failure Model

Every failure is `DingTalkError`:

- `validation`: local input/config rejected; no request was sent
- `network`: fetch threw or timeout aborted the request
- `http`: DingTalk returned non-2xx
- `rejected`: HTTP 2xx but DingTalk returned `errcode !== 0`

`retryable` is true only for `network` and HTTP 5xx. Do not retry DingTalk business rejections or HTTP 4xx by default.

## Publishing

Publishing is CI-only via tags. Do not run `npm publish` locally.

```bash
npm version <patch|minor|major>
git push --follow-tags
```

The GitHub workflow publishes with `npm publish --provenance --access public`.
