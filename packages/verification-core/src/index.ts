export { API_ERROR_CODES, VERIFICATION_ERROR_CODES, VERIFICATION_STATUSES } from './error-codes.js';
export { isKnownApiErrorCode } from './error-codes.js';
export type {
  ApiErrorCode,
  KnownApiErrorCode,
  Open,
  VerificationErrorCode,
  VerificationStatus,
} from './error-codes.js';

export { DELIVERY_METHODS, expectsCode, isKnownDeliveryMethod } from './delivery-method.js';
export type { DeliveryMethod, KnownDeliveryMethod } from './delivery-method.js';

export {
  ApiError,
  BalanceInsufficientError,
  ChannelMismatchError,
  ConfigurationError,
  DecodingError,
  DidwwError,
  NotFoundError,
  ServerError,
  TransportError,
  UnauthorizedError,
  ValidationError,
  isApiError,
  isDidwwError,
} from './errors.js';
export type { ApiErrorItem } from './errors.js';

export { isFinished, isPending } from './verification.js';
export type { CalloutInfo, SmsInfo, Verification, VerificationResult } from './verification.js';

export { INTERNAL_APP_HASH_KEY } from './options.js';
export type {
  CalloutOptions,
  ClientOptions,
  InternalSmsOptions,
  RawReportOptions,
  ReportOptions,
  RetryPolicy,
  SmsOptions,
  StartOptions,
} from './options.js';

export { VerificationClient } from './client.js';

export type { HttpRequest, HttpResponse, Transport } from './transport.js';
export { fetchTransport } from './transport.js';
export type { FetchTransportOptions } from './transport.js';
export type { AuthProvider, AuthRequest } from './auth.js';
export { basicAuth, publicAuth } from './auth.js';
