import { DingTalkError } from './errors.js';
import type {
  ComboInput,
  ComboResult,
  DingTalkOptions,
  MarkdownBody,
  NotifyBody,
  NotifyResult,
  TextBody,
} from './types.js';

const DEFAULT_BASE_URL = 'https://dingtalk-notify.210k.cc';
const NOTIFY_PATH = '/api/v1/notify';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_USER_AGENT = '@frankie0736/dingtalk-notify';
const MOBILE_RE = /^\+?\d{6,20}$/;

/** Server response envelope (snake_case wire shape). */
interface NotifyResponseBody {
  ok?: boolean;
  error?: string;
  details?: unknown;
  log_id?: string;
  request_id?: string;
  dingtalk?: {
    http_status?: number | null;
    errcode?: number | null;
    errmsg?: string | null;
    raw_body?: string;
  };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Client for the DingTalk Notification Server.
 *
 * ```ts
 * const dt = new DingTalk({ token: process.env.DINGTALK_TOKEN! });
 * await dt.text('🔔 Build #123 failed', { atMobiles: ['13800138000'] });
 * ```
 *
 * Every method throws {@link DingTalkError} on failure — including the
 * easy-to-miss case where the transport succeeds but DingTalk rejects the
 * message (HTTP 200, `ok:false`).
 */
export class DingTalk {
  readonly #token: string;
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #retries: number;
  readonly #fetch: typeof fetch;
  readonly #userAgent: string;

  constructor(options: DingTalkOptions) {
    if (!options || typeof options.token !== 'string' || options.token.length === 0) {
      throw new DingTalkError({ kind: 'validation', message: 'token is required' });
    }
    const base = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.#token = options.token;
    this.#url = base + NOTIFY_PATH;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retries = Math.max(0, options.retries ?? 0);
    this.#userAgent = options.userAgent ?? DEFAULT_USER_AGENT;

    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== 'function') {
      throw new DingTalkError({
        kind: 'validation',
        message: 'global fetch is unavailable; pass options.fetch',
      });
    }
    // Preserve `this` binding for environments where fetch is a bound global.
    this.#fetch = f.bind(globalThis);
  }

  /** Thin core: send a fully-formed message body. */
  async notify(body: NotifyBody): Promise<NotifyResult> {
    const wire = buildWire(body);
    return this.#sendWithRetry(wire);
  }

  /** Send a plain `text` message. `atMobiles` here triggers a real @-push. */
  async text(
    content: string,
    opts: { atMobiles?: string[]; atAll?: boolean } = {},
  ): Promise<NotifyResult> {
    const body: TextBody = { type: 'text', content };
    if (opts.atMobiles !== undefined) body.atMobiles = opts.atMobiles;
    if (opts.atAll !== undefined) body.atAll = opts.atAll;
    return this.notify(body);
  }

  /**
   * Send a `markdown` card. Note: per the DingTalk platform, `@` mentions
   * render in the card but do **not** fire a device push — use {@link combo}
   * (or a separate {@link text} call) when you need the push.
   */
  async markdown(
    title: string,
    content: string,
    opts: { atMobiles?: string[]; atAll?: boolean } = {},
  ): Promise<NotifyResult> {
    const body: MarkdownBody = { type: 'markdown', title, content };
    if (opts.atMobiles !== undefined) body.atMobiles = opts.atMobiles;
    if (opts.atAll !== undefined) body.atAll = opts.atAll;
    return this.notify(body);
  }

  /**
   * Recommended pattern when you want both a reliable @-push and rich content:
   * send a short `text` (the actual notification, carrying the @) followed by a
   * `markdown` card with the full detail.
   *
   * The `text` leg is sent first because it is the real push. If the `markdown`
   * leg then fails, the thrown {@link DingTalkError} carries `comboLeg:'markdown'`
   * and the already-succeeded `text` result on `comboPartial.text`.
   */
  async combo(input: ComboInput): Promise<ComboResult> {
    const at: { atMobiles?: string[]; atAll?: boolean } = {};
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

  async #sendWithRetry(wire: WireBody): Promise<NotifyResult> {
    let attempt = 0;
    for (;;) {
      try {
        return await this.#sendOnce(wire);
      } catch (err) {
        const isRetryable = err instanceof DingTalkError && err.retryable;
        if (!isRetryable || attempt >= this.#retries) throw err;
        await sleep(250 * 2 ** attempt);
        attempt += 1;
      }
    }
  }

  async #sendOnce(wire: WireBody): Promise<NotifyResult> {
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.#timeoutMs);

    let res: Response;
    try {
      res = await this.#fetch(this.#url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Authorization: `Bearer ${this.#token}`,
          'User-Agent': this.#userAgent,
        },
        body: JSON.stringify(wire),
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

    const rawText = await res.text().catch(() => '');
    let parsed: NotifyResponseBody | undefined;
    if (rawText.length > 0) {
      try {
        parsed = JSON.parse(rawText) as NotifyResponseBody;
      } catch {
        parsed = undefined;
      }
    }

    if (!res.ok) {
      throw new DingTalkError({
        kind: 'http',
        status: res.status,
        message: `server returned HTTP ${res.status}${parsed?.error ? ` (${parsed.error})` : ''}`,
        ...(parsed?.error !== undefined ? { serverError: parsed.error } : {}),
        ...(parsed?.details !== undefined ? { details: parsed.details } : {}),
        ...(parsed?.request_id !== undefined ? { requestId: parsed.request_id } : {}),
      });
    }

    if (!parsed) {
      throw new DingTalkError({
        kind: 'http',
        status: res.status,
        message: `server returned HTTP ${res.status} with an unparseable body`,
      });
    }

    const dt = parsed.dingtalk ?? {};
    if (parsed.ok === true) {
      return {
        logId: parsed.log_id ?? '',
        requestId: parsed.request_id ?? '',
        dingtalk: {
          httpStatus: dt.http_status ?? null,
          errcode: dt.errcode ?? null,
          errmsg: dt.errmsg ?? null,
        },
      };
    }

    // HTTP 200 but DingTalk rejected the message.
    throw new DingTalkError({
      kind: 'rejected',
      message: `DingTalk rejected the message: ${dt.errmsg ?? 'unknown'} (errcode ${dt.errcode ?? 'unknown'})`,
      errcode: dt.errcode ?? null,
      errmsg: dt.errmsg ?? null,
      ...(dt.raw_body !== undefined ? { rawBody: dt.raw_body } : {}),
      ...(parsed.log_id !== undefined ? { logId: parsed.log_id } : {}),
      ...(parsed.request_id !== undefined ? { requestId: parsed.request_id } : {}),
    });
  }
}

interface WireBody {
  type: 'text' | 'markdown';
  content: string;
  title?: string;
  at_mobiles?: string[];
  at_all?: boolean;
}

/**
 * Re-wrap a leg failure with combo context, preserving every field. Non-SDK
 * errors (which shouldn't normally occur) are returned untouched.
 */
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
    ...(err.serverError !== undefined ? { serverError: err.serverError } : {}),
    ...(err.details !== undefined ? { details: err.details } : {}),
    ...(err.errcode !== undefined ? { errcode: err.errcode } : {}),
    ...(err.errmsg !== undefined ? { errmsg: err.errmsg } : {}),
    ...(err.rawBody !== undefined ? { rawBody: err.rawBody } : {}),
    ...(err.logId !== undefined ? { logId: err.logId } : {}),
    ...(err.requestId !== undefined ? { requestId: err.requestId } : {}),
    comboLeg: leg,
    ...(partial !== undefined ? { comboPartial: partial } : {}),
    cause: err,
  });
}

/** Validate input at the boundary and convert to the snake_case wire shape. */
function buildWire(body: NotifyBody): WireBody {
  if (!body || (body.type !== 'text' && body.type !== 'markdown')) {
    throw new DingTalkError({
      kind: 'validation',
      message: "type must be 'text' or 'markdown'",
    });
  }

  if (typeof body.content !== 'string' || body.content.length < 1 || body.content.length > 20_000) {
    throw new DingTalkError({
      kind: 'validation',
      message: 'content must be a string of 1–20000 chars',
    });
  }

  const wire: WireBody = { type: body.type, content: body.content };

  if (body.type === 'markdown') {
    if (typeof body.title !== 'string' || body.title.length < 1 || body.title.length > 200) {
      throw new DingTalkError({
        kind: 'validation',
        message: 'markdown title must be a string of 1–200 chars',
      });
    }
    wire.title = body.title;
  }

  const atMobiles = body.atMobiles;
  if (atMobiles !== undefined) {
    if (!Array.isArray(atMobiles) || atMobiles.length > 50) {
      throw new DingTalkError({
        kind: 'validation',
        message: 'atMobiles must be an array of at most 50 numbers',
      });
    }
    for (const m of atMobiles) {
      if (typeof m !== 'string' || !MOBILE_RE.test(m)) {
        throw new DingTalkError({
          kind: 'validation',
          message: `invalid mobile number: ${String(m)} (expected /^\\+?\\d{6,20}$/)`,
        });
      }
    }
    if (atMobiles.length > 0) wire.at_mobiles = atMobiles;
  }

  if (body.atAll === true) {
    if (wire.at_mobiles && wire.at_mobiles.length > 0) {
      throw new DingTalkError({
        kind: 'validation',
        message: 'atAll and atMobiles are mutually exclusive',
      });
    }
    wire.at_all = true;
  }

  return wire;
}
