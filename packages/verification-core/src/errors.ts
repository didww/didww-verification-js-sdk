import type { DeliveryMethod } from './delivery-method.js';
import type { ApiErrorCode } from './error-codes.js';

// Global-registry symbols: two installed copies of this package put a second set of these classes
// in the tree, and only `Symbol.for` yields the same symbol in both. Changing either key silently
// breaks every guard against the other copy. Typed `symbol` and set in the constructors, never a
// `unique symbol` class field — that is nominal per declaration site, which would put the
// duplicate-copy hazard back into the published `.d.ts`.
const DIDWW_ERROR_BRAND: symbol = Symbol.for('@didww/verification-core#DidwwError');
const API_ERROR_BRAND: symbol = Symbol.for('@didww/verification-core#ApiError');

/** One element of the API's `{ errors: [...] }` envelope. `detail` is display-only prose. */
export interface ApiErrorItem {
  readonly code: ApiErrorCode;
  readonly detail: string | null;
}

/** Base of every error this SDK throws. */
export class DidwwError extends Error {
  override readonly name: string = 'DidwwError';

  constructor(message: string) {
    super(message);
    // Restores the subclass prototype when the emitted code targets ES5, where `super()` returns a
    // plain `Error` and `instanceof` on every subclass would otherwise be false.
    Object.setPrototypeOf(this, new.target.prototype);
    // `defineProperty`, not assignment: non-enumerable keeps the brand out of `Object.keys`,
    // spreads and `JSON.stringify` of a caught error.
    Object.defineProperty(this, DIDWW_ERROR_BRAND, { value: true });
  }
}

/** The SDK was set up wrong — a bad secret, a malformed app hash. Never a server response. */
export class ConfigurationError extends DidwwError {
  override readonly name = 'ConfigurationError';
}

/** A report carried the wrong value field for the channel the verification was started on. */
export class ChannelMismatchError extends DidwwError {
  override readonly name = 'ChannelMismatchError';
  readonly expected: DeliveryMethod;

  constructor(message: string, expected: DeliveryMethod) {
    super(message);
    this.expected = expected;
  }
}

/** The request never produced a response: network failure, timeout, abort. */
export class TransportError extends DidwwError {
  override readonly name = 'TransportError';
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.cause = cause;
  }
}

/** A response arrived but its body was not the JSON this release expects. */
export class DecodingError extends DidwwError {
  override readonly name = 'DecodingError';
  readonly body: string;

  constructor(message: string, body: string) {
    super(message);
    this.body = body;
  }
}

/** An error response the API itself produced, carrying the decoded envelope. */
export class ApiError extends DidwwError {
  override readonly name: string = 'ApiError';
  readonly status: number;
  /** Wire order. A validation failure over several fields returns one element per field. */
  readonly errors: readonly ApiErrorItem[];
  /** The first item's code, or `null` — a decoder must not assume the array is non-empty. */
  readonly code: ApiErrorCode | null;
  readonly codes: readonly ApiErrorCode[];
  readonly responseBody: string;

  constructor(status: number, errors: readonly ApiErrorItem[], responseBody: string) {
    const items = [...errors];
    const first = items[0];
    super(`HTTP ${status}${first === undefined ? '' : `: ${first.code}`}`);
    this.status = status;
    this.errors = items;
    this.code = first === undefined ? null : first.code;
    this.codes = items.map((item) => item.code);
    this.responseBody = responseBody;
    Object.defineProperty(this, API_ERROR_BRAND, { value: true });
  }
}

/** 401. A plan-less account answers this too, by design. */
export class UnauthorizedError extends ApiError {
  override readonly name = 'UnauthorizedError';
}

/** 402. */
export class BalanceInsufficientError extends ApiError {
  override readonly name = 'BalanceInsufficientError';
}

/** 404. */
export class NotFoundError extends ApiError {
  override readonly name = 'NotFoundError';
}

/** 400 and 422. */
export class ValidationError extends ApiError {
  override readonly name = 'ValidationError';
}

/** 5xx. */
export class ServerError extends ApiError {
  override readonly name = 'ServerError';
}

/**
 * A status this release does not model yields a plain `ApiError` — never a throw and never a
 * neighbouring subclass, so an unforeseen status still reaches the caller with its envelope.
 */
export function apiErrorForStatus(
  status: number,
  errors: readonly ApiErrorItem[],
  responseBody: string,
): ApiError {
  switch (status) {
    case 400:
    case 422:
      return new ValidationError(status, errors, responseBody);
    case 401:
      return new UnauthorizedError(status, errors, responseBody);
    case 402:
      return new BalanceInsufficientError(status, errors, responseBody);
    case 404:
      return new NotFoundError(status, errors, responseBody);
    default:
      return status >= 500 && status <= 599
        ? new ServerError(status, errors, responseBody)
        : new ApiError(status, errors, responseBody);
  }
}

/** Prefer this to `instanceof`: it holds across a second installed copy of this package. */
export function isDidwwError(value: unknown): value is DidwwError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[DIDWW_ERROR_BRAND] === true
  );
}

/** Prefer this to `instanceof`: it holds across a second installed copy of this package. */
export function isApiError(value: unknown): value is ApiError {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<symbol, unknown>)[API_ERROR_BRAND] === true
  );
}
