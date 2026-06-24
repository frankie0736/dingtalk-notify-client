import type { NotifyResult } from './types.js';

/**
 * How a {@link DingTalkError} arose. Branch on this in a `catch`:
 *
 * - `validation` - input rejected client-side; no request was sent.
 * - `network` - fetch threw, or the request timed out.
 * - `http` - DingTalk replied with a non-2xx status.
 * - `rejected` - HTTP 2xx but DingTalk returned `errcode !== 0`.
 */
export type DingTalkErrorKind = 'validation' | 'network' | 'http' | 'rejected';

export interface DingTalkErrorInit {
  kind: DingTalkErrorKind;
  message: string;
  /** HTTP status, when one was received. */
  status?: number;
  /** DingTalk `errcode`, when DingTalk returned one. */
  errcode?: number | null;
  /** DingTalk `errmsg`, when DingTalk returned one. */
  errmsg?: string | null;
  /** DingTalk's raw response body, useful for debugging. */
  rawBody?: string;
  /** Which `combo` leg failed, when thrown from {@link DingTalk.combo}. */
  comboLeg?: 'text' | 'markdown';
  /** A `combo` leg that already succeeded before the failure. */
  comboPartial?: { text?: NotifyResult };
  /** Underlying cause (e.g. the original fetch error). */
  cause?: unknown;
}

/** The single error type thrown by every {@link DingTalk} method on failure. */
export class DingTalkError extends Error {
  readonly kind: DingTalkErrorKind;
  readonly status?: number;
  readonly errcode?: number | null;
  readonly errmsg?: string | null;
  readonly rawBody?: string;
  readonly comboLeg?: 'text' | 'markdown';
  readonly comboPartial?: { text?: NotifyResult };

  constructor(init: DingTalkErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'DingTalkError';
    this.kind = init.kind;
    this.status = init.status;
    this.errcode = init.errcode;
    this.errmsg = init.errmsg;
    this.rawBody = init.rawBody;
    this.comboLeg = init.comboLeg;
    this.comboPartial = init.comboPartial;
  }

  /** True for transient failures worth retrying (network/timeout, HTTP 5xx). */
  get retryable(): boolean {
    if (this.kind === 'network') return true;
    if (this.kind === 'http' && this.status !== undefined) return this.status >= 500;
    return false;
  }
}
