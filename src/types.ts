/** Mobile numbers to @-mention. Rule: `/^\+?\d{6,20}$/`, max 50. */
export type AtMobiles = string[];

/** Common `@` options shared by both message types. */
export interface AtOptions {
  /** Real blue-badge @ + device push only for `text` messages. */
  atMobiles?: AtMobiles;
  /** @-everyone. Mutually exclusive with a non-empty `atMobiles`. */
  atAll?: boolean;
}

/** A DingTalk `text` message: no rich formatting, but `atMobiles` triggers a real push. */
export interface TextBody extends AtOptions {
  type: 'text';
  /** 1-20000 chars. */
  content: string;
}

/** A DingTalk `markdown` message: rich formatting; `@` renders without a push. */
export interface MarkdownBody extends AtOptions {
  type: 'markdown';
  /** 1-200 chars. Shown as the card title / notification preview. */
  title: string;
  /** 1-20000 chars of DingTalk-flavored markdown. */
  content: string;
}

/** Discriminated union accepted by {@link DingTalk.notify}. */
export type NotifyBody = TextBody | MarkdownBody;

/** DingTalk's direct response, normalized to camelCase and preserving raw text. */
export interface NotifyResult {
  httpStatus: number;
  errcode: number | null;
  errmsg: string | null;
  rawBody: string;
}

/** Options for {@link DingTalk}. */
export interface DingTalkOptions {
  /** DingTalk custom robot webhook URL, including `access_token`. */
  webhook: string;
  /** DingTalk custom robot signing secret. Omit for keyword/IP-whitelist robots. */
  secret?: string;
  /** Per-request timeout in ms (via AbortController). Defaults to 10000. */
  timeoutMs?: number;
  /**
   * Retry attempts for transient failures (network error, timeout, HTTP 5xx).
   * Defaults to 0. DingTalk business rejections and HTTP 4xx are never retried.
   */
  retries?: number;
  /** Custom fetch (for tests or non-standard runtimes). Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Timestamp provider for deterministic signing tests. Defaults to `Date.now`. */
  now?: () => number;
}

/** Argument for {@link DingTalk.combo}. */
export interface ComboInput extends AtOptions {
  /** Short `text` line carrying the actual @-push. */
  alert: string;
  /** Markdown card title. */
  title: string;
  /** Markdown card body. */
  detail: string;
}

/** Result of {@link DingTalk.combo}: both legs that were sent. */
export interface ComboResult {
  text: NotifyResult;
  markdown: NotifyResult;
}
