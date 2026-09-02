import { ConfigurationError, TransportError } from './errors.js';

export interface HttpRequest {
  /** Closed and already upper-case — the client cannot emit a lower-case verb. */
  readonly method: 'GET' | 'POST' | 'PUT';
  readonly url: string;
  /**
   * Path only, no query, already percent-encoded and byte-identical to the request line — this is
   * what `application` auth signs. Derived from `url` inside the client, never taken from a caller.
   */
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  /**
   * The exact bytes sent, `undefined` rather than `''` when there is none. A bodyless request
   * carries NO `Content-Type`: the server signs the header value it received, so a transport that
   * defaults one 401s every signed GET.
   */
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

export type Transport = (request: HttpRequest) => Promise<HttpResponse>;

export interface FetchTransportOptions {
  /** Defaults to the ambient `fetch`, read per request so a polyfill installed later is picked up. */
  readonly fetch?: typeof globalThis.fetch;
  /** Absent means no timeout. Composes with a per-request `signal`; neither replaces the other. */
  readonly timeoutMs?: number;
}

/**
 * A {@link Transport} over `fetch`. Every header is sent exactly as given and none is added, so a
 * bodyless request sends no `Content-Type`. A request whose `Content-Type` and body disagree is
 * refused rather than sent, because either way it signs a string the server will not compute.
 *
 * A non-2xx response is an ordinary {@link HttpResponse}; only failing to obtain one throws, as a
 * {@link TransportError}. `Headers` lower-cases response names and joins repeats with `', '`.
 */
export function fetchTransport(options: FetchTransportOptions = {}): Transport {
  const { fetch: injectedFetch, timeoutMs } = options;

  return async (request: HttpRequest): Promise<HttpResponse> => {
    const call = injectedFetch ?? globalThis.fetch;
    if (typeof call !== 'function') {
      throw new ConfigurationError(
        'No `fetch` is available in this runtime; pass one as fetchTransport({ fetch }).',
      );
    }

    // The server signs the Content-Type it received, so a request whose header and signed value can
    // differ is refused rather than sent: `fetch` synthesises `text/plain;charset=UTF-8` for an
    // untyped string body, and a provider's type on a bodyless request would be signed as `''`.
    if (hasContentType(request.headers)) {
      if (request.body === undefined) {
        throw new ConfigurationError(
          'A request with no body must send no Content-Type header; it is signed as the empty ' +
            'string, so sending one 401s the request.',
        );
      }
    } else if (request.body !== undefined) {
      throw new ConfigurationError(
        'A request with a body must carry a Content-Type header; `fetch` would otherwise put ' +
          '`text/plain;charset=UTF-8` on the wire, which is not what was signed.',
      );
    }

    const abort = composeAbort(request.signal, timeoutMs);
    const init: RequestInit = {
      method: request.method,
      headers: { ...request.headers },
      ...(request.body === undefined ? {} : { body: request.body }),
      ...(abort.signal === undefined ? {} : { signal: abort.signal }),
    };

    try {
      const response = await call(request.url, init);
      return {
        status: response.status,
        headers: collectHeaders(response.headers),
        body: await response.text(),
      };
    } catch (error) {
      throw new TransportError(abort.abortMessage() ?? 'Request failed', error);
    } finally {
      abort.cleanup();
    }
  };
}

function hasContentType(headers: Readonly<Record<string, string>>): boolean {
  return Object.keys(headers).some((name) => name.toLowerCase() === 'content-type');
}

function collectHeaders(headers: Headers): Record<string, string> {
  const collected: Record<string, string> = {};
  headers.forEach((value, name) => {
    const existing = collected[name];
    collected[name] = existing === undefined ? value : `${existing}, ${value}`;
  });
  return collected;
}

const CALLER_ABORTED = 'Request aborted by the caller';

interface AbortComposition {
  readonly signal: AbortSignal | undefined;
  /** The message of whichever source aborted first, or `undefined` if neither did. */
  abortMessage(): string | undefined;
  cleanup(): void;
}

function composeAbort(
  callerSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortComposition {
  let message: string | undefined;
  const teardown: Array<() => void> = [];
  const cleanup = (): void => {
    for (const undo of teardown) undo();
    teardown.length = 0;
  };
  const abortMessage = (): string | undefined => message;

  const watch = (
    signal: AbortSignal,
    aborted: string,
    forward?: (reason: unknown) => void,
  ): void => {
    const onAbort = (): void => {
      message ??= aborted;
      forward?.(signal.reason);
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort);
    teardown.push(() => {
      signal.removeEventListener('abort', onAbort);
    });
  };

  if (timeoutMs === undefined) {
    if (callerSignal !== undefined) watch(callerSignal, CALLER_ABORTED);
    return { signal: callerSignal, abortMessage, cleanup };
  }

  const timedOut = `Request timed out after ${timeoutMs}ms`;

  // `AbortSignal.any` and `AbortSignal.timeout` are absent on Hermes and on older Node, so the
  // composition falls back to a controller plus a timer that is always cleared.
  if (typeof AbortSignal.timeout === 'function' && typeof AbortSignal.any === 'function') {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    watch(timeoutSignal, timedOut);
    if (callerSignal === undefined) return { signal: timeoutSignal, abortMessage, cleanup };
    watch(callerSignal, CALLER_ABORTED);
    return { signal: AbortSignal.any([callerSignal, timeoutSignal]), abortMessage, cleanup };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    message ??= timedOut;
    controller.abort(timeoutReason(timedOut));
  }, timeoutMs);
  teardown.push(() => {
    clearTimeout(timer);
  });
  if (callerSignal !== undefined) {
    watch(callerSignal, CALLER_ABORTED, (reason) => {
      controller.abort(reason);
    });
  }
  return { signal: controller.signal, abortMessage, cleanup };
}

function timeoutReason(message: string): Error {
  // Named as `AbortSignal.timeout` names its own reason, so a caller can tell a timeout from a
  // cancellation whichever path ran; `DOMException` is not on every runtime this package targets.
  const reason = new Error(message);
  reason.name = 'TimeoutError';
  return reason;
}
