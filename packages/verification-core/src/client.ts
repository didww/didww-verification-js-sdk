import type { AuthProvider } from './auth.js';
import { expectsCode, type DeliveryMethod } from './delivery-method.js';
import {
  ChannelMismatchError,
  ConfigurationError,
  apiErrorForStatus,
  type ApiErrorItem,
} from './errors.js';
import type {
  ClientOptions,
  RawReportOptions,
  ReportOptions,
  RetryPolicy,
  StartOptions,
} from './options.js';
import { digitsOf } from './phone-number.js';
import { redact } from './redact.js';
import { DEFAULT_RETRY_POLICY, withRetry } from './retry.js';
import {
  fetchTransport,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from './transport.js';
import type { Verification, VerificationResult } from './verification.js';
import {
  decodeErrorEnvelope,
  decodeVerificationEnvelope,
  encodeReportRequest,
  encodeStartRequest,
} from './wire.js';

/**
 * From `baseUrls` in the wire snapshot. Constants because a published package cannot read a repo
 * file at runtime; asserted against the snapshot in `scripts/contract-vocabulary.test.mjs`.
 */
export const PRODUCTION_BASE_URL = 'https://verification.didww.com';
export const SANDBOX_BASE_URL = 'https://verification-sandbox.didww.com';

const BASE_URLS = { production: PRODUCTION_BASE_URL, sandbox: SANDBOX_BASE_URL };

const VERIFICATIONS_ROUTE = '/api/v1/verifications';
const BY_NUMBER_ROUTE = `${VERIFICATIONS_ROUTE}/by_number`;
const JSON_CONTENT_TYPE = 'application/json';
const DEFAULT_TIMEOUT_MS = 30_000;

/** A request target. `path` is what `application` auth signs, and is never accepted from a caller. */
interface RequestTarget {
  readonly url: string;
  readonly path: string;
}

interface RequestSpec extends RequestTarget {
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly body?: string;
  readonly signal?: AbortSignal;
}

function baseUrlOf(options: ClientOptions): URL {
  const raw = options.baseUrl ?? BASE_URLS[options.environment ?? 'production'];
  try {
    return new URL(raw);
  } catch {
    throw new ConfigurationError(`baseUrl is not a valid absolute URL: ${JSON.stringify(raw)}`);
  }
}

function assertChannelPairing(method: DeliveryMethod, field: 'code' | 'cli'): void {
  const wantsCode = expectsCode(method);
  if (wantsCode === undefined || wantsCode === (field === 'code')) {
    return;
  }
  throw new ChannelMismatchError(
    `A ${method} verification is reported with \`${wantsCode ? 'code' : 'cli'}\`, not \`${field}\`.`,
    method,
  );
}

// An ingress can answer 502 with HTML that was never this API's envelope; the status still decides
// the class, and the undecoded body travels on the error.
function decodeErrorItems(body: string): readonly ApiErrorItem[] {
  try {
    return decodeErrorEnvelope(body);
  } catch {
    return [];
  }
}

/**
 * The client for the Verification API. Every method is `async`, so a guard that fails before the
 * request is issued rejects rather than throwing past a caller that only wrote `.catch`.
 */
export class VerificationClient {
  readonly #baseUrl: URL;
  readonly #auth: AuthProvider;
  readonly #transport: Transport;
  readonly #retry: RetryPolicy;
  readonly #userAgent: string | undefined;
  readonly #logger: ((line: string) => void) | undefined;
  readonly #keepRawPayload: boolean;

  constructor(options: ClientOptions) {
    this.#baseUrl = baseUrlOf(options);
    this.#auth = options.auth;
    this.#transport =
      options.transport ?? fetchTransport({ timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    this.#retry = options.retry ?? DEFAULT_RETRY_POLICY;
    this.#userAgent = options.userAgent;
    this.#logger = options.logger;
    this.#keepRawPayload = options.keepRawPayload === true;
  }

  async startVerification(options: StartOptions): Promise<Verification> {
    return this.#send({
      method: 'POST',
      ...this.#target(VERIFICATIONS_ROUTE),
      body: encodeStartRequest(options),
      ...signalOf(options.signal),
    });
  }

  async reportVerification(id: string, options: ReportOptions): Promise<VerificationResult> {
    return this.#report(this.#target(idRoute(id)), options, true);
  }

  async getVerification(
    id: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<VerificationResult> {
    return this.#get(this.#target(idRoute(id)), options.signal);
  }

  async reportVerificationByNumber(
    number: string,
    options: ReportOptions,
  ): Promise<VerificationResult> {
    return this.#report(this.#target(byNumberRoute(number)), options, true);
  }

  async getVerificationByNumber(
    number: string,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<VerificationResult> {
    return this.#get(this.#target(byNumberRoute(number)), options.signal);
  }

  /**
   * Escape hatch for a channel this release does not model: no client-side channel guard runs, and
   * the caller names the value field the server expects.
   */
  async reportVerificationRaw(id: string, options: RawReportOptions): Promise<VerificationResult> {
    return this.#report(this.#target(idRoute(id)), options, false);
  }

  /** {@link reportVerificationRaw}, addressed by destination. */
  async reportVerificationRawByNumber(
    number: string,
    options: RawReportOptions,
  ): Promise<VerificationResult> {
    return this.#report(this.#target(byNumberRoute(number)), options, false);
  }

  // The one derivation of a request target: `path` is the path portion of `url` by construction, so
  // the signed string cannot drift from the request line.
  #target(route: string): RequestTarget {
    const path = `${this.#baseUrl.pathname.replace(/\/+$/, '')}${route}`;
    return { url: `${this.#baseUrl.origin}${path}`, path };
  }

  // Retry is confined here, to a request that is a GET by construction. A create or a report that
  // timed out may still have landed, so retrying one double-charges and supersedes.
  #get(target: RequestTarget, signal: AbortSignal | undefined): Promise<VerificationResult> {
    return withRetry(
      () => this.#send({ method: 'GET', ...target, ...signalOf(signal) }),
      this.#retry,
    );
  }

  #report(
    target: RequestTarget,
    options: RawReportOptions,
    guardChannel: boolean,
  ): Promise<VerificationResult> {
    // With neither field supplied `code` is sent empty on purpose: `code_blank` is the server's
    // judgement to make, and a local throw here would just guess at it.
    const field = options.code === undefined && options.cli !== undefined ? 'cli' : 'code';
    if (guardChannel) {
      assertChannelPairing(options.deliveryMethod, field);
    }
    // PUT, not PATCH: the routes accept either and the verb is inside the signed string, so it is
    // pinned rather than left implicit.
    return this.#send({
      method: 'PUT',
      ...target,
      body: encodeReportRequest(options.deliveryMethod, field, options.code ?? options.cli),
      ...signalOf(options.signal),
    });
  }

  async #send(spec: RequestSpec): Promise<Verification> {
    const body = spec.body;
    // A bodyless request carries no Content-Type header and signs `''` on that line: the server
    // signs the header value it received, so a defaulted one 401s every signed GET.
    const contentType = body === undefined ? '' : JSON_CONTENT_TYPE;

    const authHeaders = await this.#auth.headers({
      method: spec.method,
      path: spec.path,
      contentType,
      body: body ?? '',
    });

    // Only the client may set the content type, because only the client signs it. Refused rather
    // than stripped: a provider's value survives the merge on a bodyless request (signed `''`, sent
    // typed, 401), and on a body-carrying one a differently-cased key is joined with the real value
    // by the header list rather than replacing it.
    const suppliedContentType = Object.keys(authHeaders).find(
      (name) => name.toLowerCase() === 'content-type',
    );
    if (suppliedContentType !== undefined) {
      throw new ConfigurationError(
        `The AuthProvider returned a \`${suppliedContentType}\` header. It must return only ` +
          'authentication headers: the content type is signed, so one it supplies is not the one ' +
          'the signature covers and every signed request would be rejected.',
      );
    }

    const headers: Record<string, string> = { Accept: JSON_CONTENT_TYPE, ...authHeaders };
    if (body !== undefined) {
      headers['Content-Type'] = contentType;
    }
    if (this.#userAgent !== undefined) {
      headers['User-Agent'] = this.#userAgent;
    }

    const request: HttpRequest = {
      method: spec.method,
      url: spec.url,
      path: spec.path,
      headers,
      ...(body === undefined ? {} : { body }),
      ...signalOf(spec.signal),
    };

    let response: HttpResponse;
    try {
      response = await this.#transport(request);
    } catch (error) {
      this.#log(request, 'transport error');
      throw error;
    }
    this.#log(request, response.status);

    if (response.status < 200 || response.status >= 300) {
      throw apiErrorForStatus(response.status, decodeErrorItems(response.body), response.body);
    }
    return decodeVerificationEnvelope(response.body, { keepRawPayload: this.#keepRawPayload });
  }

  // Method, URL and outcome only — never a body, and every digit run long enough to be a
  // destination is masked, because a by-number route carries one in the URL itself.
  #log(request: HttpRequest, outcome: number | string): void {
    this.#logger?.(redact(`${request.method} ${request.url} -> ${outcome}`));
  }
}

function idRoute(id: string): string {
  // An id is an opaque caller-supplied string, and the signed path keeps the encoding it gets here.
  return `${VERIFICATIONS_ROUTE}/${encodeURIComponent(id)}`;
}

function byNumberRoute(number: string): string {
  return `${BY_NUMBER_ROUTE}/${digitsOf(number)}`;
}

function signalOf(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}
