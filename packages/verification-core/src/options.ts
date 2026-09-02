import type { AuthProvider } from './auth.js';
import type { DeliveryMethod } from './delivery-method.js';
import type { Transport } from './transport.js';

export interface SmsOptions {
  /**
   * BCP-47. Template lookup is exact, so a region-less tag passes validation and then silently
   * falls back to en-US — send the region subtag. Do not add a client-side guard rejecting a tag
   * without one; that would reject what the server accepts.
   */
  readonly languages?: readonly string[];
}

export interface CalloutOptions {
  /**
   * BCP-47, same tags and same exact-match rule as {@link SmsOptions.languages}, so one list can
   * serve both channels. The recorded set is its own: a tag that resolves a template may still
   * fall back here, which `CalloutInfo.language` reports.
   */
  readonly languages?: readonly string[];
}

/**
 * Internal and excluded from semver: the key `@didww/verification-react-native` uses to hand a
 * device-computed SMS Retriever hash to the request builder, which validates it and emits it as
 * `app_hash`. A plain string rather than a `unique symbol`, which is nominal per declaration site
 * and so would not survive two installed copies of this package.
 */
export const INTERNAL_APP_HASH_KEY = '@didww/verification-core#appHash';

/** {@link SmsOptions} plus the internal app-hash key. Not part of the supported surface. */
export interface InternalSmsOptions extends SmsOptions {
  readonly [INTERNAL_APP_HASH_KEY]?: string;
}

export interface StartOptions {
  readonly destination: string;
  /** Written value: accepts an unknown channel string, but a KNOWN wrong pairing throws. */
  readonly deliveryMethod: DeliveryMethod;
  readonly sms?: SmsOptions;
  readonly callout?: CalloutOptions;
  readonly signal?: AbortSignal;
}

/**
 * Closed: `cli?: never` rejects the wrong field when it arrives through a variable rather than a
 * fresh object literal, which excess-property checking cannot see. The escape hatch for an
 * unmodelled channel is a separately-named method — an open `string & {}` arm would swallow this.
 */
export type ReportOptions = {
  deliveryMethod: 'sms' | 'callout';
  code: string;
  cli?: never;
  signal?: AbortSignal;
};

/**
 * The escape hatch's options: a channel this release does not model, and whichever value field the
 * server expects for it. No client-side channel guard runs — only the server can judge.
 */
export interface RawReportOptions {
  readonly deliveryMethod: string;
  readonly code?: string;
  readonly cli?: string;
  readonly signal?: AbortSignal;
}

export interface RetryPolicy {
  readonly attempts: number;
  readonly baseDelayMs?: number;
}

export interface ClientOptions {
  readonly auth: AuthProvider;
  /** Default `'production'`. */
  readonly environment?: 'production' | 'sandbox';
  /** Wins over `environment`. */
  readonly baseUrl?: string;
  readonly transport?: Transport;
  /** Default 30_000. */
  readonly timeoutMs?: number;
  /** GET only, structurally. Default `{ attempts: 2, baseDelayMs: 200 }`. */
  readonly retry?: RetryPolicy;
  readonly userAgent?: string;
  readonly logger?: (line: string) => void;
  /** Default false. See `Verification.unsafeRawPayload`. */
  readonly keepRawPayload?: boolean;
}
