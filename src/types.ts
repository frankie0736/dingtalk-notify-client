/**
 * Wire types — a faithful replica of the server contract in
 * `dingtalk_notification_server/src/routes/notify.ts`. Keep these in sync
 * with that file when the server's request/response shape changes.
 */

/** Mobile numbers to @-mention. Server rule: `/^\+?\d{6,20}$/`, max 50. */
export type AtMobiles = string[];

/** Common `@` options shared by both message types. */
export interface AtOptions {
  /** Real blue-badge @ + device push (only effective for `text` messages). */
  atMobiles?: AtMobiles;
  /** @-everyone. Mutually exclusive with a non-empty `atMobiles`. */
  atAll?: boolean;
}

/** A `text` message: no rich formatting, but `atMobiles` triggers a real push. */
export interface TextBody {
  type: 'text';
  /** 1–20000 chars. */
  content: string;
  atMobiles?: AtMobiles;
  atAll?: boolean;
}

/** A `markdown` message: rich formatting, but `@` renders without a push. */
export interface MarkdownBody {
  type: 'markdown';
  /** 1–200 chars. Shown as the card title / notification preview. */
  title: string;
  /** 1–20000 chars of DingTalk-flavored markdown. */
  content: string;
  atMobiles?: AtMobiles;
  atAll?: boolean;
}

/** Discriminated union accepted by {@link DingTalk.notify}. */
export type NotifyBody = TextBody | MarkdownBody;

/** DingTalk's verbatim verdict, normalized to camelCase. */
export interface DingTalkVerdict {
  httpStatus: number | null;
  errcode: number | null;
  errmsg: string | null;
}

/** Successful result of a notify call (`errcode === 0`). */
export interface NotifyResult {
  /** Server audit-log id (`lg_...`). */
  logId: string;
  /** End-to-end trace id (`rq_...`); also surfaced in server logs. */
  requestId: string;
  dingtalk: DingTalkVerdict;
}

/** Options for {@link DingTalk}. */
export interface DingTalkOptions {
  /** Per-robot bearer token (`dnk_...`). Required. */
  token: string;
  /** Server origin. Defaults to `https://dingtalk-notify.210k.cc`. */
  baseUrl?: string;
  /** Per-request timeout in ms (via AbortController). Defaults to 10000. */
  timeoutMs?: number;
  /**
   * Retry attempts for transient failures (network error, timeout, HTTP 5xx).
   * Defaults to 0. DingTalk business rejections and HTTP 4xx are never retried.
   */
  retries?: number;
  /** Custom fetch (for tests or non-standard runtimes). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Overrides the default `User-Agent` header. */
  userAgent?: string;
}

/** Argument for {@link DingTalk.combo}. */
export interface ComboInput {
  /** Short `text` line carrying the actual @-push. */
  alert: string;
  /** Markdown card title. */
  title: string;
  /** Markdown card body. */
  detail: string;
  atMobiles?: AtMobiles;
  atAll?: boolean;
}

/** Result of {@link DingTalk.combo}: both legs that were sent. */
export interface ComboResult {
  text: NotifyResult;
  markdown: NotifyResult;
}
