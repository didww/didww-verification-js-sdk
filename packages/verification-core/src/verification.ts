import type { DeliveryMethod } from './delivery-method.js';
import type { VerificationErrorCode, VerificationStatus } from './error-codes.js';

/**
 * The marker the server framed the SMS with, so the device can read the message automatically.
 * Discriminated on `type`: a marker added later becomes another member of the union.
 */
export interface SmsAutofill {
  /** Android SMS Retriever: the message ends with this build's app hash, `value`. */
  readonly type: 'app_hash';
  readonly value: string;
}

export interface SmsInfo {
  /** The message body, with the code placeholder unsubstituted. */
  readonly template: string | null;
  /**
   * The tag the server chose — your first preference that had a template, else its fallback.
   * Compare it with what you asked for to detect a fallback. Null on a verification stored
   * before the server recorded one.
   */
  readonly language: string | null;
  /** Seconds to keep an on-device listener armed. A budget, not a deadline. */
  readonly interceptionTimeoutSeconds: number | null;
  /**
   * Echoed only when a marker was stored. Null as well for a marker type this release does not
   * model, which `unsafeRawPayload` still carries. An `app_hash` equal to the one you sent is the
   * arming signal.
   */
  readonly autofill: SmsAutofill | null;
  /**
   * @deprecated Read {@link SmsInfo.autofill}. This is its `value` when the type is `app_hash`,
   * else null.
   */
  readonly appHash: string | null;
  /**
   * The generated code's length, 4–8, set per application on the server. Never compile a length
   * into the client.
   */
  readonly codeLength: number | null;
}

export interface CalloutInfo {
  /**
   * The tag the announcement is played in — your first preference that had a recording, else
   * the server's fallback. The recorded set is not the SMS one, so a tag that picks a template
   * can still fall back here. Null on a verification stored before the server recorded one.
   */
  readonly language: string | null;
  /** {@link SmsInfo.codeLength}. */
  readonly codeLength: number | null;
}

export interface Verification {
  readonly id: string;
  readonly destination: string;
  readonly deliveryMethod: DeliveryMethod;
  /**
   * Decimal string, VAT included — never a `number`. A quote, not a charge: billed only on a
   * verified outcome, with the message or call billed separately as ordinary traffic.
   */
  readonly fee: string | null;
  /**
   * `expired` is SYNTHESISED on read: an unfinished verification past its deadline reads as
   * `expired` with `errorCode: 'expired'` though the column is null, so a poll can reach it with
   * nothing having been written.
   */
  readonly status: VerificationStatus;
  readonly errorCode: VerificationErrorCode | null;
  /** Fixed prose selected by `errorCode`. Display only — switch on the code, never parse this. */
  readonly errorDetail: string | null;
  /**
   * Nullable on purpose. Nothing produces null today, but the response is built through a null-safe
   * read, so a non-nullable decoder survives every response until the one that carries null, then
   * throws.
   */
  readonly expiresAt: Date | null;
  /** Non-null exactly when `deliveryMethod === 'sms'`. */
  readonly sms: SmsInfo | null;
  /** Non-null exactly when `deliveryMethod === 'callout'`. */
  readonly callout: CalloutInfo | null;
  /**
   * Present only when `ClientOptions.keepRawPayload` is true. Unsupported and excluded from
   * semver.
   */
  readonly unsafeRawPayload?: Readonly<Record<string, unknown>>;
}

export type VerificationResult = Verification;

/** True while the outcome is still being decided — the condition to keep polling on. */
export function isPending(verification: Verification): boolean {
  return verification.status === 'pending';
}

/**
 * The exact complement of `isPending`, so a status this release does not model reads as finished
 * and a `while (!isFinished(v))` poll terminates instead of spinning.
 */
export function isFinished(verification: Verification): boolean {
  return !isPending(verification);
}
