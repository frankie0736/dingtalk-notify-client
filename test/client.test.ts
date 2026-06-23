import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DingTalk, DingTalkError } from '../dist/index.js';

/** A recorded fetch call. */
interface Call {
  url: string;
  init: RequestInit;
}

/**
 * Build a client whose fetch is scripted. `responder` receives the call index
 * and returns either a Response or a rejection. All calls are recorded.
 */
function makeClient(
  responder: (callIndex: number, call: Call) => Promise<Response>,
  opts: Partial<ConstructorParameters<typeof DingTalk>[0]> = {},
) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const call: Call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return responder(calls.length - 1, call);
  }) as unknown as typeof fetch;

  const client = new DingTalk({ token: 'dnk_test', fetch: fetchImpl, ...opts });
  return { client, calls };
}

const okBody = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    ok: true,
    log_id: 'lg_1',
    request_id: 'rq_1',
    dingtalk: { http_status: 200, errcode: 0, errmsg: 'ok' },
    ...over,
  });

const jsonResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

const bodyOf = (call: Call) => JSON.parse(call.init.body as string);

test('text(): assembles request and returns normalized result', async () => {
  const { client, calls } = makeClient(async () => jsonResponse(okBody()));
  const result = await client.text('hello', { atMobiles: ['13800138000'] });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(call.url, 'https://dingtalk-notify.210k.cc/api/v1/notify');
  assert.equal(call.init.method, 'POST');
  const headers = call.init.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer dnk_test');
  assert.equal(headers['Content-Type'], 'application/json');

  assert.deepEqual(bodyOf(call), {
    type: 'text',
    content: 'hello',
    at_mobiles: ['13800138000'],
  });

  assert.deepEqual(result, {
    logId: 'lg_1',
    requestId: 'rq_1',
    dingtalk: { httpStatus: 200, errcode: 0, errmsg: 'ok' },
  });
});

test('markdown(): sends title + content, no at by default', async () => {
  const { client, calls } = makeClient(async () => jsonResponse(okBody()));
  await client.markdown('Build #123', '### detail');
  assert.deepEqual(bodyOf(calls[0]!), {
    type: 'markdown',
    title: 'Build #123',
    content: '### detail',
  });
});

test('atAll true sends at_all and omits at_mobiles', async () => {
  const { client, calls } = makeClient(async () => jsonResponse(okBody()));
  await client.text('all hands', { atAll: true });
  assert.deepEqual(bodyOf(calls[0]!), { type: 'text', content: 'all hands', at_all: true });
});

test('validation: atAll and atMobiles are mutually exclusive (no request sent)', async () => {
  const { client, calls } = makeClient(async () => jsonResponse(okBody()));
  await assert.rejects(
    () => client.text('x', { atAll: true, atMobiles: ['13800138000'] }),
    (err: unknown) => err instanceof DingTalkError && err.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

test('validation: bad mobile number rejected before sending', async () => {
  const { client, calls } = makeClient(async () => jsonResponse(okBody()));
  await assert.rejects(
    () => client.text('x', { atMobiles: ['not-a-number'] }),
    (err: unknown) => err instanceof DingTalkError && err.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

test('validation: empty content and missing type', async () => {
  const { client, calls } = makeClient(async () => jsonResponse(okBody()));
  await assert.rejects(
    () => client.text(''),
    (err: unknown) => err instanceof DingTalkError && err.kind === 'validation',
  );
  await assert.rejects(
    // @ts-expect-error intentionally invalid body
    () => client.notify({ content: 'x' }),
    (err: unknown) => err instanceof DingTalkError && err.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

test('rejected: HTTP 200 with ok:false throws kind=rejected with detail', async () => {
  const { client, calls } = makeClient(async () =>
    jsonResponse(
      JSON.stringify({
        ok: false,
        log_id: 'lg_9',
        request_id: 'rq_9',
        dingtalk: { http_status: 200, errcode: 310000, errmsg: 'sign not match', raw_body: '{"errcode":310000}' },
      }),
    ),
  );
  await assert.rejects(
    () => client.text('hi'),
    (err: unknown) => {
      assert.ok(err instanceof DingTalkError);
      assert.equal(err.kind, 'rejected');
      assert.equal(err.errcode, 310000);
      assert.equal(err.errmsg, 'sign not match');
      assert.equal(err.logId, 'lg_9');
      assert.equal(err.requestId, 'rq_9');
      assert.equal(err.rawBody, '{"errcode":310000}');
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test('http: non-2xx throws kind=http with serverError code', async () => {
  const { client } = makeClient(async () =>
    jsonResponse(JSON.stringify({ ok: false, error: 'invalid_token' }), 401),
  );
  await assert.rejects(
    () => client.text('hi'),
    (err: unknown) => {
      assert.ok(err instanceof DingTalkError);
      assert.equal(err.kind, 'http');
      assert.equal(err.status, 401);
      assert.equal(err.serverError, 'invalid_token');
      assert.equal(err.retryable, false);
      return true;
    },
  );
});

test('network: fetch rejection throws kind=network', async () => {
  const { client, calls } = makeClient(async () => {
    throw new Error('ECONNREFUSED');
  });
  await assert.rejects(
    () => client.text('hi'),
    (err: unknown) => err instanceof DingTalkError && err.kind === 'network',
  );
  assert.equal(calls.length, 1);
});

test('retries: network error retried up to the limit then thrown', async () => {
  const { client, calls } = makeClient(
    async () => {
      throw new Error('boom');
    },
    { retries: 2 },
  );
  await assert.rejects(() => client.text('hi'), DingTalkError);
  assert.equal(calls.length, 3); // 1 initial + 2 retries
});

test('retries: HTTP 5xx retried, then succeeds', async () => {
  const { client, calls } = makeClient(
    async (i) => (i === 0 ? jsonResponse('{}', 503) : jsonResponse(okBody())),
    { retries: 1 },
  );
  const result = await client.text('hi');
  assert.equal(calls.length, 2);
  assert.equal(result.logId, 'lg_1');
});

test('retries: rejected (ok:false) is NOT retried', async () => {
  const { client, calls } = makeClient(
    async () => jsonResponse(JSON.stringify({ ok: false, dingtalk: { errcode: 310000, errmsg: 'x' } })),
    { retries: 3 },
  );
  await assert.rejects(() => client.text('hi'), DingTalkError);
  assert.equal(calls.length, 1);
});

test('timeout: aborts and throws kind=network', async () => {
  const { client } = makeClient(
    (_i, call) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = call.init.signal as AbortSignal | undefined;
        signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    { timeoutMs: 20 },
  );
  await assert.rejects(
    () => client.text('hi'),
    (err: unknown) => {
      assert.ok(err instanceof DingTalkError);
      assert.equal(err.kind, 'network');
      assert.match(err.message, /timed out/);
      return true;
    },
  );
});

test('combo: sends text then markdown in order', async () => {
  const { client, calls } = makeClient(async () => jsonResponse(okBody()));
  const result = await client.combo({
    alert: '🔔 Build #123 failed',
    title: 'Build #123',
    detail: '### main 失败',
    atMobiles: ['13800138000'],
  });

  assert.equal(calls.length, 2);
  assert.equal(bodyOf(calls[0]!).type, 'text');
  assert.deepEqual(bodyOf(calls[0]!).at_mobiles, ['13800138000']);
  assert.equal(bodyOf(calls[1]!).type, 'markdown');
  assert.equal(bodyOf(calls[1]!).title, 'Build #123');
  assert.equal(result.text.logId, 'lg_1');
  assert.equal(result.markdown.logId, 'lg_1');
});

test('combo: markdown leg failure carries comboLeg + partial text result', async () => {
  const { client } = makeClient(async (i) =>
    i === 0
      ? jsonResponse(okBody({ log_id: 'lg_text' }))
      : jsonResponse(JSON.stringify({ ok: false, dingtalk: { errcode: 1, errmsg: 'nope' } })),
  );
  await assert.rejects(
    () => client.combo({ alert: 'a', title: 't', detail: 'd' }),
    (err: unknown) => {
      assert.ok(err instanceof DingTalkError);
      assert.equal(err.comboLeg, 'markdown');
      assert.equal(err.kind, 'rejected');
      assert.equal(err.comboPartial?.text?.logId, 'lg_text');
      return true;
    },
  );
});

test('constructor: missing token throws validation error', () => {
  assert.throws(
    // @ts-expect-error intentionally missing token
    () => new DingTalk({}),
    (err: unknown) => err instanceof DingTalkError && err.kind === 'validation',
  );
});

test('baseUrl override and trailing slash trimming', async () => {
  const { client, calls } = makeClient(async () => jsonResponse(okBody()), {
    baseUrl: 'https://example.com/',
  });
  await client.text('hi');
  assert.equal(calls[0]!.url, 'https://example.com/api/v1/notify');
});
