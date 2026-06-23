import type { NotifyResult } from './types.js';

/**
 * How a {@link DingTalkError} arose. Branch on this in a `catch`:
 *
 * - `validation` — input rejected client-side; **no request was sent**.
 * - `network`    — fetch threw, or the request timed out.
 * - `http`       — server replied with a non-2xx status.
 * - `rejected`   — HTTP 200 but DingTalk rejected it (`ok:false`, `errcode !== 0`).
 *
 * The `rejected` case is the easy-to-miss one: the transport succeeded, so a
 * bare fetch wrapper would treat it as success. The SDK surfaces it as an error.
 */
export type DingTalkErrorKind = 'validation' | 'network' | 'http' | 'rejected';

export interface DingTalkErrorInit {
  kind: DingTalkErrorKind;
  message: string;
  /** HTTP status, when one was received. */
  status?: number;
  /** Server error code string, e.g. `invalid_token` / `validation_failed`. */
  serverError?: string;
  /** Server-provided validation details (zod issues or a message string). */
  details?: unknown;
  /** DingTalk `errcode` (for `rejected`). */
  errcode?: number | null;
  /** DingTalk `errmsg` (for `rejected`). */
  errmsg?: string | null;
  /** DingTalk's raw response body (for `rejected`), useful for debugging. */
  rawBody?: string;
  /** Server audit-log id, when known. */
  logId?: string;
  /** Trace id, when known. */
  requestId?: string;
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
  readonly serverError?: string;
  readonly details?: unknown;
  readonly errcode?: number | null;
  readonly errmsg?: string | null;
  readonly rawBody?: string;
  readonly logId?: string;
  readonly requestId?: string;
  readonly comboLeg?: 'text' | 'markdown';
  readonly comboPartial?: { text?: NotifyResult };

  constructor(init: DingTalkErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'DingTalkError';
    this.kind = init.kind;
    this.status = init.status;
    this.serverError = init.serverError;
    this.details = init.details;
    this.errcode = init.errcode;
    this.errmsg = init.errmsg;
    this.rawBody = init.rawBody;
    this.logId = init.logId;
    this.requestId = init.requestId;
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
