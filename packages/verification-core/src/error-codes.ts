/**
 * Widens a closed set of known strings while keeping the members visible to editor completion.
 * Applied to DECODED values only: a value the SDK writes is never `Open<>`, because a channel
 * or code the server has not heard of is a request that fails.
 */
export type Open<T extends string> = T | (string & {});

export const VERIFICATION_STATUSES = [
  'pending',
  'verified',
  'failed',
  'expired',
  'denied',
] as const;

export const VERIFICATION_ERROR_CODES = [
  'dispatch_failed',
  'expired',
  'too_many_attempts',
  // Deprecated: no longer sent, reported as `dispatch_failed`. Removed in the next major version.
  'stale_dispatch',
  'application_deleted',
  'superseded',
  'denied_missing_callback_url',
  'denied_by_callback',
  'denied_invalid_callback_response',
  'application_paused',
  'destination_country_disabled',
  // No longer a 422 on start; kept in API_ERROR_CODES for compatibility.
  'destination_not_supported_for_channel',
] as const;

export const API_ERROR_CODES = [
  'destination_blank',
  'destination_invalid',
  'delivery_method_blank',
  'delivery_method_inclusion',
  'delivery_method_invalid',
  'languages_invalid',
  'autofill_invalid',
  'app_hash_invalid',
  'sms_domain_not_configured',
  'template_group_not_found',
  'custom_too_long',
  'code_blank',
  'code_value_present',
  'cli_blank',
  'cli_value_present',
  'code_invalid',
  'cli_invalid',
  'already_verified',
  'not_ready_to_report',
  'parameter_missing',
  'not_found',
  'unauthorized',
  'balance_insufficient',
  'validation_failed',
  'internal_error',
  'destination_in_cooldown',
  'rate_limit_per_ip',
  'rate_limit_failed_auth',
  'rate_limit_per_account',
  'rate_limit_public_per_account',
  'volume_limit_reached',
  ...VERIFICATION_ERROR_CODES,
] as const;

export const TEMPLATE_FALLBACK_REASONS = [
  'language_missing',
  'version_pending',
  'version_rejected',
  'audio_not_ready',
  'group_missing',
] as const;

export type KnownApiErrorCode = (typeof API_ERROR_CODES)[number];

/** Decoded. A status added after this release arrives as a new string, never as null. */
export type VerificationStatus = Open<(typeof VERIFICATION_STATUSES)[number]>;
/** Decoded. */
export type VerificationErrorCode = Open<(typeof VERIFICATION_ERROR_CODES)[number]>;
/** Decoded. */
export type ApiErrorCode = Open<KnownApiErrorCode>;
/** Decoded. */
export type TemplateFallbackReason = Open<(typeof TEMPLATE_FALLBACK_REASONS)[number]>;

/** True when this release models the code, so a `switch` over it is exhaustive. */
export function isKnownApiErrorCode(value: string): value is KnownApiErrorCode {
  return (API_ERROR_CODES as readonly string[]).includes(value);
}
