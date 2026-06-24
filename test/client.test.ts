import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DingTalk, DingTalkError } from '../dist/index.js';

interface Call {
  url: string;
  init: RequestInit;
}

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

  const client = new DingTalk({
    webhook: 'https://oapi.dingtalk.com/robot/send?access_token=token_123',
    secret: 'SEC_test',
    fetch: fetchImpl,
    now: () => 1_700_000_000_000,
    ...opts,
  });
  return { client, calls };
}

const jsonResponse = (body: string, status = 200) =>
  new Response(body, { status, headers: { 'Content-Type': 'application/json' } });

const bodyOf = (call: Call) => JSON.parse(call.init.body as string);

test('text(): posts DingTalk text body to signed webhook', async () => {
  const { client, calls } = makeClient(async () => jsonResponse('{"errcode":0,"errmsg":"ok"}'));
  const result = await client.text('hello', { atMobiles: ['13800138000'] });

  assert.equal(calls.length, 1);
  const call = calls[0]!;
  assert.equal(
    call.url,
    'https://oapi.dingtalk.com/robot/send?access_token=token_123&timestamp=1700000000000&sign=UPWQtQtng95%2FqLc6VTYVwWhYnvgmht2uu5Rt3a1meak%3D',
  );
  assert.equal(call.init.method, 'POST');
  assert.deepEqual(call.init.headers, { 'Content-Type': 'application/json; charset=utf-8' });
  assert.deepEqual(bodyOf(call), {
    msgtype: 'text',
    text: { content: 'hello' },
    at: { atMobiles: ['13800138000'], isAtAll: false },
  });
  assert.deepEqual(result, { httpStatus: 200, errcode: 0, errmsg: 'ok', rawBody: '{"errcode":0,"errmsg":"ok"}' });
});

test('markdown(): appends literal mobile mentions for DingTalk name rendering', async () => {
  const { client, calls } = makeClient(async () => jsonResponse('{"errcode":0,"errmsg":"ok"}'));
  await client.markdown('Build #123', '### detail', { atMobiles: ['13800138000', '+8613900139000'] });

  assert.deepEqual(bodyOf(calls[0]!), {
    msgtype: 'markdown',
    markdown: { title: 'Build #123', text: '### detail\n\n@13800138000 @+8613900139000 ' },
    at: { atMobiles: ['13800138000', '+8613900139000'], isAtAll: false },
  });
});

test('secret is optional: unsigned robots post the original webhook URL', async () => {
  const { client, calls } = makeClient(async () => jsonResponse('{"errcode":0,"errmsg":"ok"}'), {
    secret: undefined,
  });
  await client.text('keyword mode');
  assert.equal(calls[0]!.url, 'https://oapi.dingtalk.com/robot/send?access_token=token_123');
});

test('atAll true sends isAtAll and omits atMobiles', async () => {
  const { client, calls } = makeClient(async () => jsonResponse('{"errcode":0,"errmsg":"ok"}'));
  await client.text('all hands', { atAll: true });
  assert.deepEqual(bodyOf(calls[0]!), {
    msgtype: 'text',
    text: { content: 'all hands' },
    at: { atMobiles: [], isAtAll: true },
  });
});

test('validation: atAll and atMobiles are mutually exclusive (no request sent)', async () => {
  const { client, calls } = makeClient(async () => jsonResponse('{"errcode":0,"errmsg":"ok"}'));
  await assert.rejects(
    () => client.text('x', { atAll: true, atMobiles: ['13800138000'] }),
    (err: unknown) => err instanceof DingTalkError && err.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

test('validation: bad mobile number rejected before sending', async () => {
  const { client, calls } = makeClient(async () => jsonResponse('{"errcode":0,"errmsg":"ok"}'));
  await assert.rejects(
    () => client.text('x', { atMobiles: ['not-a-number'] }),
    (err: unknown) => err instanceof DingTalkError && err.kind === 'validation',
  );
  assert.equal(calls.length, 0);
});

test('validation: empty content and missing type', async () => {
  const { client, calls } = makeClient(async () => jsonResponse('{"errcode":0,"errmsg":"ok"}'));
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

test('rejected: HTTP 200 with errcode!=0 throws kind=rejected with DingTalk detail', async () => {
  const { client, calls } = makeClient(async () =>
    jsonResponse('{"errcode":310000,"errmsg":"sign not match"}'),
  );
  await assert.rejects(
    () => client.text('hi'),
    (err: unknown) => {
      assert.ok(err instanceof DingTalkError);
      assert.equal(err.kind, 'rejected');
      assert.equal(err.errcode, 310000);
      assert.equal(err.errmsg, 'sign not match');
      assert.equal(err.rawBody, '{"errcode":310000,"errmsg":"sign not match"}');
      assert.equal(err.retryable, false);
      return true;
    },
  );
  assert.equal(calls.length, 1);
});

test('http: non-2xx throws kind=http with raw body', async () => {
  const { client } = makeClient(async () => jsonResponse('gateway unavailable', 503));
  await assert.rejects(
    () => client.text('hi'),
    (err: unknown) => {
      assert.ok(err instanceof DingTalkError);
      assert.equal(err.kind, 'http');
      assert.equal(err.status, 503);
      assert.equal(err.rawBody, 'gateway unavailable');
      assert.equal(err.retryable, true);
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
  assert.equal(calls.length, 3);
});

test('retries: HTTP 5xx retried, then succeeds', async () => {
  const { client, calls } = makeClient(
    async (i) => (i === 0 ? jsonResponse('{}', 503) : jsonResponse('{"errcode":0,"errmsg":"ok"}')),
    { retries: 1 },
  );
  const result = await client.text('hi');
  assert.equal(calls.length, 2);
  assert.equal(result.errcode, 0);
});

test('retries: rejected is NOT retried', async () => {
  const { client, calls } = makeClient(
    async () => jsonResponse('{"errcode":310000,"errmsg":"x"}'),
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
  const { client, calls } = makeClient(async () => jsonResponse('{"errcode":0,"errmsg":"ok"}'));
  const result = await client.combo({
    alert: 'Build #123 failed',
    title: 'Build #123',
    detail: '### main failed',
    atMobiles: ['13800138000'],
  });

  assert.equal(calls.length, 2);
  assert.equal(bodyOf(calls[0]!).msgtype, 'text');
  assert.deepEqual(bodyOf(calls[0]!).at.atMobiles, ['13800138000']);
  assert.equal(bodyOf(calls[1]!).msgtype, 'markdown');
  assert.equal(bodyOf(calls[1]!).markdown.title, 'Build #123');
  assert.equal(result.text.errcode, 0);
  assert.equal(result.markdown.errcode, 0);
});

test('combo: markdown leg failure carries comboLeg + partial text result', async () => {
  const { client } = makeClient(async (i) =>
    i === 0 ? jsonResponse('{"errcode":0,"errmsg":"ok"}') : jsonResponse('{"errcode":1,"errmsg":"nope"}'),
  );
  await assert.rejects(
    () => client.combo({ alert: 'a', title: 't', detail: 'd' }),
    (err: unknown) => {
      assert.ok(err instanceof DingTalkError);
      assert.equal(err.comboLeg, 'markdown');
      assert.equal(err.kind, 'rejected');
      assert.equal(err.comboPartial?.text?.errcode, 0);
      return true;
    },
  );
});

test('constructor: missing webhook throws validation error', () => {
  assert.throws(
    // @ts-expect-error intentionally missing webhook
    () => new DingTalk({}),
    (err: unknown) => err instanceof DingTalkError && err.kind === 'validation',
  );
});
