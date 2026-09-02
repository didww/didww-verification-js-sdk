import { ConfigurationError, DecodingError, type ApiErrorItem } from './errors.js';
import {
  INTERNAL_APP_HASH_KEY,
  type CalloutOptions,
  type InternalSmsOptions,
  type SmsOptions,
  type StartOptions,
} from './options.js';
import type { CalloutInfo, SmsInfo, Verification } from './verification.js';

// The malformed/unknown boundary: a body that is not JSON, a field of the wrong JSON type, and a
// missing non-nullable field are MALFORMED and throw `DecodingError`. A right-typed value this
// release does not model — a status, channel or error code added later — is UNKNOWN and passes through.

export interface DecodeOptions {
  /** See `Verification.unsafeRawPayload`. */
  readonly keepRawPayload?: boolean;
}

function fail(message: string, body: string): never {
  throw new DecodingError(message, body);
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return fail('Response body is not JSON.', body);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requiredString(source: Record<string, unknown>, key: string, body: string): string {
  const value = source[key];
  if (typeof value !== 'string') {
    fail(`\`${key}\` is missing or not a string.`, body);
  }
  return value;
}

function nullableString(source: Record<string, unknown>, key: string, body: string): string | null {
  const value = source[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    fail(`\`${key}\` is not a string.`, body);
  }
  return value;
}

function nullableNumber(source: Record<string, unknown>, key: string, body: string): number | null {
  const value = source[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`\`${key}\` is not a number.`, body);
  }
  return value;
}

const ISO_8601_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function isRealCalendarDay(day: string): boolean {
  const probe = new Date(`${day}T00:00:00Z`);
  return !Number.isNaN(probe.getTime()) && probe.toISOString().startsWith(day);
}

// `expires_at` is nullable, so null decodes to null. Anything else must be a real ISO-8601 instant:
// `new Date` alone reads `"2026"` and `"25 Aug 2026"` as confident wrong instants and rolls
// `"2026-02-30"` into March, either of which would disarm an on-device listener silently.
function decodeExpiresAt(source: Record<string, unknown>, body: string): Date | null {
  const raw = nullableString(source, 'expires_at', body);
  if (raw === null) {
    return null;
  }
  const expiresAt = new Date(raw);
  if (
    !ISO_8601_TIMESTAMP.test(raw) ||
    Number.isNaN(expiresAt.getTime()) ||
    !isRealCalendarDay(raw.slice(0, 10))
  ) {
    fail('`expires_at` is not an ISO-8601 timestamp.', body);
  }
  return expiresAt;
}

// A channel block is absent on every other channel, so a missing or null one is not malformed.
// Keyed off the block rather than off `delivery_method`, so a block the server sends on an
// unexpected channel still decodes.
function optionalBlock<T>(
  data: Record<string, unknown>,
  key: string,
  decode: (source: Record<string, unknown>, body: string) => T,
  body: string,
): T | null {
  const value = data[key];
  if (value === undefined || value === null) {
    return null;
  }
  const source = asRecord(value);
  if (source === null) {
    fail(`\`${key}\` is present but is not an object.`, body);
  }
  return decode(source, body);
}

// `language` is read nullably though the specification requires it: the column behind it is
// nullable, so a verification stored before the server recorded one answers with null.
function decodeSms(source: Record<string, unknown>, body: string): SmsInfo {
  return {
    template: nullableString(source, 'template', body),
    language: nullableString(source, 'language', body),
    interceptionTimeoutSeconds: nullableNumber(source, 'interception_timeout', body),
    appHash: nullableString(source, 'app_hash', body),
  };
}

function decodeCallout(source: Record<string, unknown>, body: string): CalloutInfo {
  return { language: nullableString(source, 'language', body) };
}

/** Decodes a verification response body. Throws `DecodingError` on a malformed one. */
export function decodeVerificationEnvelope(
  body: string,
  options: DecodeOptions = {},
): Verification {
  const root = asRecord(parseJson(body));
  if (root === null) {
    fail('Response body is not a JSON object.', body);
  }
  const data = asRecord(root['data']);
  if (data === null) {
    fail('Response body carries no `data` object.', body);
  }

  const verification: Verification = {
    id: requiredString(data, 'id', body),
    destination: requiredString(data, 'destination', body),
    deliveryMethod: requiredString(data, 'delivery_method', body),
    // Never `Number()` it: that is a rounding bug in a billing display, and the value is a quote
    // to show, not one to compute with.
    fee: nullableString(data, 'fee', body),
    status: requiredString(data, 'status', body),
    errorCode: nullableString(data, 'error_code', body),
    errorDetail: nullableString(data, 'error_detail', body),
    expiresAt: decodeExpiresAt(data, body),
    sms: optionalBlock(data, 'sms', decodeSms, body),
    callout: optionalBlock(data, 'callout', decodeCallout, body),
  };

  if (options.keepRawPayload !== true) {
    return verification;
  }
  return { ...verification, unsafeRawPayload: data };
}

/** Decodes an error response body into wire order. Throws `DecodingError` on a malformed one. */
export function decodeErrorEnvelope(body: string): readonly ApiErrorItem[] {
  const root = asRecord(parseJson(body));
  if (root === null) {
    fail('Response body is not a JSON object.', body);
  }
  const errors: unknown = root['errors'];
  if (!Array.isArray(errors)) {
    fail('Response body carries no `errors` array.', body);
  }
  return (errors as readonly unknown[]).map((entry) => {
    const source = asRecord(entry);
    if (source === null) {
      fail('`errors` carries an entry that is not an object.', body);
    }
    return {
      code: requiredString(source, 'code', body),
      detail: nullableString(source, 'detail', body),
    };
  });
}

// ---- request builders -------------------------------------------------------

/**
 * From `constraints.appHash` in the wire snapshot, and asserted against it in
 * `scripts/contract-vocabulary.test.mjs`.
 */
export const APP_HASH_PATTERN = /^[A-Za-z0-9+/]{11}$/;

// The gate lives here rather than in the package that computes the hash: a malformed one fails the
// whole verification with `app_hash_invalid`, not just autofill, so no caller may bypass it.
function validAppHash(value: unknown): string {
  if (typeof value !== 'string' || !APP_HASH_PATTERN.test(value)) {
    throw new ConfigurationError(
      'The SMS Retriever app hash must be 11 characters of A-Z, a-z, 0-9, "+" or "/"; the server ' +
        'fails the whole verification on a malformed one rather than ignoring it.',
    );
  }
  return value;
}

/**
 * Drops every key whose value is `undefined`, and the block itself once nothing is left — an empty
 * block would be a meaningless key on the wire. Adding a field to a channel is one entry here, and
 * the emptiness rule follows it automatically.
 */
function blockOf(entries: Record<string, unknown>): Record<string, unknown> | undefined {
  const kept = Object.entries(entries).filter(([, value]) => value !== undefined);
  return kept.length === 0 ? undefined : Object.fromEntries(kept);
}

function languagesOf(options: { readonly languages?: readonly string[] }): string[] | undefined {
  return options.languages === undefined ? undefined : [...options.languages];
}

function encodeSmsBlock(options: SmsOptions | undefined): Record<string, unknown> | undefined {
  if (options === undefined) {
    return undefined;
  }
  const appHash = (options as InternalSmsOptions)[INTERNAL_APP_HASH_KEY];
  return blockOf({
    languages: languagesOf(options),
    app_hash: appHash === undefined ? undefined : validAppHash(appHash),
  });
}

function encodeCalloutBlock(
  options: CalloutOptions | undefined,
): Record<string, unknown> | undefined {
  return options === undefined ? undefined : blockOf({ languages: languagesOf(options) });
}

/**
 * The `POST /verifications` body. Only the block matching `delivery_method` is read, so each block
 * is emitted only for its own channel — but every encoder runs whatever the channel, so the app
 * hash is validated wherever it was supplied and a wrong channel cannot smuggle a malformed one
 * past the gate. Adding a channel is one entry in the map.
 */
export function encodeStartRequest(options: StartOptions): string {
  const blocks = new Map<string, Record<string, unknown> | undefined>([
    ['sms', encodeSmsBlock(options.sms)],
    ['callout', encodeCalloutBlock(options.callout)],
  ]);
  const data: Record<string, unknown> = {
    destination: options.destination,
    delivery_method: options.deliveryMethod,
  };
  const block = blocks.get(options.deliveryMethod);
  if (block !== undefined) {
    data[options.deliveryMethod] = block;
  }
  return JSON.stringify({ data });
}

/** The report body. An absent value is left off, so the server answers `code_blank`/`cli_blank`. */
export function encodeReportRequest(
  deliveryMethod: string,
  field: 'code' | 'cli',
  value: string | undefined,
): string {
  const data: Record<string, unknown> = { delivery_method: deliveryMethod };
  if (value !== undefined) {
    data[field] = value;
  }
  return JSON.stringify({ data });
}
