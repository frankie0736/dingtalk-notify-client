import { DingTalkError } from './errors.js';
import type {
  AtOptions,
  ComboInput,
  ComboResult,
  DingTalkOptions,
  MarkdownBody,
  NotifyBody,
  NotifyResult,
  TextBody,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 10_000;
const MOBILE_RE = /^\+?\d{6,20}$/;
const enc = new TextEncoder();

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export class DingTalk {
  readonly #webhook: string;
  readonly #secret?: string;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;

  constructor(options: DingTalkOptions) {
    if (!options || typeof options.webhook !== 'string' || options.webhook.length === 0) {
      throw new DingTalkError({ kind: 'validation', message: 'webhook is required' });
    }
    if (options.secret !== undefined && (typeof options.secret !== 'string' || options.secret.length === 0)) {
      throw new DingTalkError({ kind: 'validation', message: 'secret must be a non-empty string when provided' });
    }

    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new DingTalkError({
        kind: 'validation',
        message: 'global fetch is unavailable; pass options.fetch',
      });
    }

    this.#webhook = options.webhook;
    this.#secret = options.secret;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retries = Math.max(0, options.retries ?? 0);
    this.#fetch = f.bind(globalThis);
    this.#now = options.now ?? Date.now;
  }

  /** Send a fully-formed `text` or `markdown` message. */
  async notify(body: NotifyBody): Promise<NotifyResult> {
    const wire = buildDingTalkBody(validateBody(body));
    return this.#sendWithRetry(wire);
  }

  /** Send a plain `text` message. `atMobiles` here triggers a real @-push. */
  async text(content: string, opts: AtOptions = {}): Promise<NotifyResult> {
    const body: TextBody = { type: 'text', content };
    if (opts.atMobiles !== undefined) body.atMobiles = opts.atMobiles;
    if (opts.atAll !== undefined) body.atAll = opts.atAll;
    return this.notify(body);
  }

  /**
   * Send a `markdown` card. Per DingTalk, `@` mentions render in the card but
   * do not fire a device push; use {@link combo} when you need both.
   */
  async markdown(title: string, content: string, opts: AtOptions = {}): Promise<NotifyResult> {
    const body: MarkdownBody = { type: 'markdown', title, content };
    if (opts.atMobiles !== undefined) body.atMobiles = opts.atMobiles;
    if (opts.atAll !== undefined) body.atAll = opts.atAll;
    return this.notify(body);
  }

  /**
   * Send a short `text` push first, then a rich `markdown` card. If the second
   * leg fails, the thrown error carries `comboPartial.text`.
   */
  async combo(input: ComboInput): Promise<ComboResult> {
    const at: AtOptions = {};
    if (input.atMobiles !== undefined) at.atMobiles = input.atMobiles;
    if (input.atAll !== undefined) at.atAll = input.atAll;

    let textResult: NotifyResult;
    try {
      textResult = await this.text(input.alert, at);
    } catch (err) {
      throw tagComboLeg(err, 'text');
    }

    try {
      const markdownResult = await this.markdown(input.title, input.detail);
      return { text: textResult, markdown: markdownResult };
    } catch (err) {
      throw tagComboLeg(err, 'markdown', { text: textResult });
    }
  }

  async #sendWithRetry(body: DingTalkWireBody): Promise<NotifyResult> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.#sendOnce(body);
      } catch (err) {
        const isRetryable = err instanceof DingTalkError && err.retryable;
        if (!isRetryable || attempt >= this.#retries) throw err;
        await sleep(250 * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  async #sendOnce(body: DingTalkWireBody): Promise<NotifyResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    let res: Response;
    try {
      res = await this.#fetch(await this.#requestUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err) {
      throw new DingTalkError({
        kind: 'network',
        message: timedOut ? `request timed out after ${this.#timeoutMs}ms` : 'network request failed',
        cause: err,
      });
    } finally {
      clearTimeout(timer);
    }

    const rawBody = await res.text().catch(() => '');
    const parsed = parseDingTalkResponse(rawBody);

    if (!res.ok) {
      throw new DingTalkError({
        kind: 'http',
        status: res.status,
        message: `DingTalk returned HTTP ${res.status}`,
        errcode: parsed.errcode,
        errmsg: parsed.errmsg,
        rawBody,
      });
    }

    if (parsed.errcode === 0) {
      return {
        httpStatus: res.status,
        errcode: parsed.errcode,
        errmsg: parsed.errmsg,
        rawBody,
      };
    }

    throw new DingTalkError({
      kind: 'rejected',
      message: `DingTalk rejected the message: ${parsed.errmsg ?? 'unknown'} (errcode ${parsed.errcode ?? 'unknown'})`,
      errcode: parsed.errcode,
      errmsg: parsed.errmsg,
      rawBody,
    });
  }

  async #requestUrl(): Promise<string> {
    if (this.#secret === undefined) return this.#webhook;
    return buildSignedUrl(this.#webhook, this.#secret, this.#now().toString());
  }
}

interface NormalizedBody {
  type: 'text' | 'markdown';
  content: string;
  title?: string;
  atMobiles?: string[];
  atAll?: boolean;
}

type DingTalkWireBody =
  | {
      msgtype: 'text';
      text: { content: string };
      at: { atMobiles: string[]; isAtAll: boolean };
    }
  | {
      msgtype: 'markdown';
      markdown: { title: string; text: string };
      at: { atMobiles: string[]; isAtAll: boolean };
    };

interface ParsedDingTalkResponse {
  errcode: number | null;
  errmsg: string | null;
}

function b64encode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

async function sign(secret: string, timestamp: string): Promise<string> {
  const stringToSign = `${timestamp}\n${secret}`;
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(stringToSign)));
  return encodeURIComponent(b64encode(sig));
}

async function buildSignedUrl(webhook: string, secret: string, timestamp: string): Promise<string> {
  const s = await sign(secret, timestamp);
  const sep = webhook.includes('?') ? '&' : '?';
  return `${webhook}${sep}timestamp=${timestamp}&sign=${s}`;
}

function validateBody(body: NotifyBody): NormalizedBody {
  if (!body || (body.type !== 'text' && body.type !== 'markdown')) {
    throw new DingTalkError({
      kind: 'validation',
      message: "type must be 'text' or 'markdown'",
    });
  }

  if (typeof body.content !== 'string' || body.content.length < 1 || body.content.length > 20_000) {
    throw new DingTalkError({
      kind: 'validation',
      message: 'content must be a string of 1-20000 chars',
    });
  }

  const normalized: NormalizedBody = { type: body.type, content: body.content };

  if (body.type === 'markdown') {
    if (typeof body.title !== 'string' || body.title.length < 1 || body.title.length > 200) {
      throw new DingTalkError({
        kind: 'validation',
        message: 'markdown title must be a string of 1-200 chars',
      });
    }
    normalized.title = body.title;
  }

  if (body.atMobiles !== undefined) {
    if (!Array.isArray(body.atMobiles) || body.atMobiles.length > 50) {
      throw new DingTalkError({
        kind: 'validation',
        message: 'atMobiles must be an array of at most 50 numbers',
      });
    }
    for (const m of body.atMobiles) {
      if (typeof m !== 'string' || !MOBILE_RE.test(m)) {
        throw new DingTalkError({
          kind: 'validation',
          message: `invalid mobile number: ${String(m)} (expected /^\\+?\\d{6,20}$/)`,
        });
      }
    }
    if (body.atMobiles.length > 0) normalized.atMobiles = body.atMobiles;
  }

  if (body.atAll === true) {
    if (normalized.atMobiles && normalized.atMobiles.length > 0) {
      throw new DingTalkError({
        kind: 'validation',
        message: 'atAll and atMobiles are mutually exclusive',
      });
    }
    normalized.atAll = true;
  }

  return normalized;
}

function buildDingTalkBody(input: NormalizedBody): DingTalkWireBody {
  const at = {
    atMobiles: input.atMobiles ?? [],
    isAtAll: input.atAll === true,
  };

  if (input.type === 'text') {
    return {
      msgtype: 'text',
      text: { content: input.content },
      at,
    };
  }

  const trailingMentions =
    input.atMobiles && input.atMobiles.length > 0
      ? '\n\n' + input.atMobiles.map((m) => `@${m} `).join('')
      : '';

  return {
    msgtype: 'markdown',
    markdown: {
      title: input.title ?? 'Notification',
      text: input.content + trailingMentions,
    },
    at,
  };
}

function parseDingTalkResponse(rawBody: string): ParsedDingTalkResponse {
  try {
    const parsed = JSON.parse(rawBody) as Partial<{ errcode: unknown; errmsg: unknown }>;
    return {
      errcode: typeof parsed.errcode === 'number' ? parsed.errcode : null,
      errmsg: typeof parsed.errmsg === 'string' ? parsed.errmsg : null,
    };
  } catch {
    return { errcode: null, errmsg: null };
  }
}

function tagComboLeg(
  err: unknown,
  leg: 'text' | 'markdown',
  partial?: { text?: NotifyResult },
): unknown {
  if (!(err instanceof DingTalkError)) return err;
  return new DingTalkError({
    kind: err.kind,
    message: `combo ${leg} leg failed: ${err.message}`,
    ...(err.status !== undefined ? { status: err.status } : {}),
    ...(err.errcode !== undefined ? { errcode: err.errcode } : {}),
    ...(err.errmsg !== undefined ? { errmsg: err.errmsg } : {}),
    ...(err.rawBody !== undefined ? { rawBody: err.rawBody } : {}),
    comboLeg: leg,
    ...(partial !== undefined ? { comboPartial: partial } : {}),
    cause: err,
  });
}
