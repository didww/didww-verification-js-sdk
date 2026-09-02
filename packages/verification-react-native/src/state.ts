import type {
  ApiErrorItem,
  CalloutInfo,
  DeliveryMethod,
  SmsInfo,
  VerificationErrorCode,
} from '@didww/verification-core';

/** A failure this SDK produced itself, never a decoded server response. */
export type SdkError =
  | { readonly code: 'already_running' }
  /** In-process supersession. The wire has a slug of the same name; `source` is the disambiguator. */
  | { readonly code: 'superseded' }
  | { readonly code: 'transport'; readonly message: string }
  | { readonly code: 'decoding'; readonly message: string };

/** Why a verification ended in `failed`, and which side decided it. */
export type FailureReason =
  | { readonly source: 'api'; readonly error: ApiErrorItem }
  | { readonly source: 'sdk'; readonly error: SdkError };

/** Everything the host renders from. `verified`, `failed`, `denied`, `expired` and `setupError` are terminal. */
export type VerificationState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'starting' }
  | {
      readonly kind: 'awaitingInput';
      readonly verificationId: string;
      readonly deliveryMethod: DeliveryMethod;
      readonly destination: string;
      readonly fee: string | null;
      readonly sms: SmsInfo | null;
      readonly callout: CalloutInfo | null;
      readonly expiresAt: Date | null;
      /** The last recoverable error. The verification is still alive and accepts another value. */
      readonly lastError: ApiErrorItem | null;
    }
  /** A value arrived from SMS auto-capture and has not been submitted yet. */
  | { readonly kind: 'captured'; readonly value: string }
  | { readonly kind: 'submitting' }
  | { readonly kind: 'verified'; readonly verificationId: string }
  | { readonly kind: 'failed'; readonly reason: FailureReason }
  | { readonly kind: 'denied'; readonly error: ApiErrorItem | null }
  | { readonly kind: 'expired' }
  /** The application is misconfigured; retrying the same call cannot succeed. */
  | {
      readonly kind: 'setupError';
      readonly code: VerificationErrorCode;
      readonly detail: string | null;
    };
