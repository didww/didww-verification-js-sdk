import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigurationError, TransportError } from './errors.js';
import { fetchTransport, type HttpRequest } from './transport.js';

const GET: HttpRequest = {
  method: 'GET',
  url: 'https://api.example.test/v1/verifications/abc',
  path: '/v1/verifications/abc',
  headers: { Authorization: 'Application key:sig', 'x-timestamp': '1700000000' },
};

const POST: HttpRequest = {
  method: 'POST',
  url: 'https://api.example.test/v1/verifications',
  path: '/v1/verifications',
  headers: { 'Content-Type': 'application/json', 'x-timestamp': '1700000000' },
  body: '{"identity":{"endpoint":"+15551234567"}}',
};

interface Call {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function recordingFetch(respond: () => Response): {
  fetchImpl: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = ((input, init) => {
    calls.push({ url: String(input), init });
    return Promise.resolve(respond());
  }) satisfies typeof globalThis.fetch;
  return { fetchImpl, calls };
}

/** Mirrors `fetch`: never settles on its own, and rejects with the signal's reason when aborted. */
const hangingFetch = ((_input, init) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    if (!signal) return;
    const rejectWithReason = (): void => {
      reject(signal.reason as Error);
    };
    if (signal.aborted) {
      rejectWithReason();
      return;
    }
    signal.addEventListener('abort', rejectWithReason);
  })) satisfies typeof globalThis.fetch;

const ok = (): Response => new Response('{"id":"abc"}', { status: 200 });

const sentHeaders = (call: Call): Record<string, string> =>
  (call.init?.headers ?? {}) as Record<string, string>;

const caught = async (promise: Promise<unknown>): Promise<unknown> =>
  await promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('fetchTransport request shape', () => {
  it('sends no Content-Type and no body at all on a bodyless GET', async () => {
    const { fetchImpl, calls } = recordingFetch(ok);

    await fetchTransport({ fetch: fetchImpl })(GET);

    const call = calls[0]!;
    const headers = sentHeaders(call);
    expect('Content-Type' in headers).toBe(false);
    expect('content-type' in headers).toBe(false);
    expect('body' in call.init!).toBe(false);
    expect(call.url).toBe(GET.url);
    expect(call.init?.method).toBe('GET');
  });

  it('adds no header the caller did not supply', async () => {
    const { fetchImpl, calls } = recordingFetch(ok);

    await fetchTransport({ fetch: fetchImpl })(GET);

    expect(sentHeaders(calls[0]!)).toEqual({
      Authorization: 'Application key:sig',
      'x-timestamp': '1700000000',
    });
  });

  it('adds no signal when neither a timeout nor a caller signal was given', async () => {
    const { fetchImpl, calls } = recordingFetch(ok);

    await fetchTransport({ fetch: fetchImpl })(GET);

    expect('signal' in calls[0]!.init!).toBe(false);
  });

  it('sends an application/json body and header exactly as given', async () => {
    const { fetchImpl, calls } = recordingFetch(ok);

    await fetchTransport({ fetch: fetchImpl })(POST);

    const call = calls[0]!;
    expect(sentHeaders(call)['Content-Type']).toBe('application/json');
    expect(call.init?.body).toBe(POST.body);
    expect(call.init?.method).toBe('POST');
  });

  it('keeps the parameters of a Content-Type verbatim', async () => {
    const { fetchImpl, calls } = recordingFetch(ok);
    const request: HttpRequest = {
      ...POST,
      headers: { ...POST.headers, 'Content-Type': 'application/json; charset=utf-8' },
    };

    await fetchTransport({ fetch: fetchImpl })(request);

    expect(sentHeaders(calls[0]!)['Content-Type']).toBe('application/json; charset=utf-8');
  });

  it('refuses a request that carries a body but no Content-Type', async () => {
    const { fetchImpl, calls } = recordingFetch(ok);
    const request: HttpRequest = { ...POST, headers: { 'x-timestamp': '1700000000' } };

    const error = await caught(fetchTransport({ fetch: fetchImpl })(request));

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a bodyless request that carries a Content-Type', async () => {
    const { fetchImpl, calls } = recordingFetch(ok);
    const request: HttpRequest = {
      ...GET,
      headers: { ...GET.headers, 'Content-Type': 'application/json' },
    };

    const error = await caught(fetchTransport({ fetch: fetchImpl })(request));

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a bodyless request carrying a lower-case content-type', async () => {
    const { fetchImpl, calls } = recordingFetch(ok);
    const request: HttpRequest = {
      ...GET,
      headers: { ...GET.headers, 'content-type': 'application/json' },
    };

    const error = await caught(fetchTransport({ fetch: fetchImpl })(request));

    expect(error).toBeInstanceOf(ConfigurationError);
    expect(calls).toHaveLength(0);
  });

  it('accepts a lower-case content-type on a body-carrying request', async () => {
    const { fetchImpl, calls } = recordingFetch(ok);
    const request: HttpRequest = {
      ...POST,
      headers: { 'content-type': 'application/json', 'x-timestamp': '1700000000' },
    };

    await fetchTransport({ fetch: fetchImpl })(request);

    expect(sentHeaders(calls[0]!)['content-type']).toBe('application/json');
  });
});

describe('fetchTransport responses', () => {
  it('returns a non-2xx as an ordinary response instead of throwing', async () => {
    const body = '{"errors":[{"code":"internal_error","detail":null}]}';
    const { fetchImpl } = recordingFetch(
      () => new Response(body, { status: 500, headers: { 'content-type': 'application/json' } }),
    );

    const response = await fetchTransport({ fetch: fetchImpl })(GET);

    expect(response.status).toBe(500);
    expect(response.body).toBe(body);
    expect(response.headers['content-type']).toBe('application/json');
  });

  it('joins a repeated response header with a comma and a space', async () => {
    const { fetchImpl } = recordingFetch(
      () =>
        new Response('{}', {
          status: 200,
          headers: [
            ['x-trace', 'a'],
            ['x-trace', 'b'],
            ['set-cookie', 'first=1'],
            ['set-cookie', 'second=2'],
          ],
        }),
    );

    const response = await fetchTransport({ fetch: fetchImpl })(GET);

    expect(response.headers['x-trace']).toBe('a, b');
    expect(response.headers['set-cookie']).toBe('first=1, second=2');
  });
});

describe('fetchTransport failures', () => {
  it('wraps a rejecting fetch in a TransportError carrying the original as cause', async () => {
    const boom = new Error('socket hang up');
    const failing = (() => Promise.reject(boom)) satisfies typeof globalThis.fetch;

    const error = await caught(fetchTransport({ fetch: failing })(GET));

    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toBe('Request failed');
    expect((error as TransportError).cause).toBe(boom);
  });

  it('throws a ConfigurationError when no fetch is available', async () => {
    vi.stubGlobal('fetch', undefined);
    try {
      expect(await caught(fetchTransport()(GET))).toBeInstanceOf(ConfigurationError);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses the ambient fetch when none was injected', async () => {
    const { fetchImpl, calls } = recordingFetch(ok);
    vi.stubGlobal('fetch', fetchImpl);
    try {
      expect((await fetchTransport()(GET)).status).toBe(200);
      expect(calls).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

const ABORT_STATICS = ['any', 'timeout'] as const;
const ABORT_DESCRIPTORS = ABORT_STATICS.map(
  (name) => [name, Object.getOwnPropertyDescriptor(AbortSignal, name)!] as const,
);

/**
 * The native composition arms its timer inside the host, out of reach of fake timers, so that
 * variant runs a real millisecond-scale timeout; the fallback's own timer is advanced instead.
 */
describe.each([
  { label: 'natively', stripped: false, timeoutMs: 10 },
  { label: 'without AbortSignal.any and AbortSignal.timeout', stripped: true, timeoutMs: 5_000 },
])('fetchTransport composes timeout and signal $label', ({ stripped, timeoutMs }) => {
  const strip = (): void => {
    if (!stripped) return;
    for (const [name] of ABORT_DESCRIPTORS) Reflect.deleteProperty(AbortSignal, name);
  };
  const fireTimeout = async (): Promise<void> => {
    if (stripped) await vi.advanceTimersByTimeAsync(timeoutMs);
  };

  afterEach(() => {
    for (const [name, descriptor] of ABORT_DESCRIPTORS) {
      Object.defineProperty(AbortSignal, name, descriptor);
    }
    vi.useRealTimers();
  });

  it('aborts a hanging request when the timeout fires', async () => {
    // The native composition arms a host timer, so that variant must be on the real clock even if
    // an earlier test file in this worker left fake timers installed.
    if (stripped) vi.useFakeTimers();
    else vi.useRealTimers();
    strip();

    const pending = caught(fetchTransport({ fetch: hangingFetch, timeoutMs })(GET));
    await fireTimeout();
    const error = await pending;

    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toBe(`Request timed out after ${timeoutMs}ms`);
    expect((error as TransportError).cause).toMatchObject({ name: 'TimeoutError' });
  });

  it("reports a caller's abort as a cancellation even with a timeout configured", async () => {
    vi.useFakeTimers();
    strip();
    const controller = new AbortController();
    const transport = fetchTransport({ fetch: hangingFetch, timeoutMs: 60_000 });

    const pending = caught(transport({ ...GET, signal: controller.signal }));
    controller.abort();
    const error = await pending;

    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toBe('Request aborted by the caller');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a caller signal that was already aborted as a cancellation', async () => {
    vi.useFakeTimers();
    strip();
    const transport = fetchTransport({ fetch: hangingFetch, timeoutMs: 60_000 });

    const error = await caught(transport({ ...GET, signal: AbortSignal.abort() }));

    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toBe('Request aborted by the caller');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves no timer behind once a request settles', async () => {
    vi.useFakeTimers();
    strip();
    const { fetchImpl } = recordingFetch(ok);

    await fetchTransport({ fetch: fetchImpl, timeoutMs: 60_000 })(GET);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('fetchTransport caller signal without a timeout', () => {
  it('passes the caller signal straight through', async () => {
    const { fetchImpl, calls } = recordingFetch(ok);
    const controller = new AbortController();

    await fetchTransport({ fetch: fetchImpl })({ ...GET, signal: controller.signal });

    expect(calls[0]?.init?.signal).toBe(controller.signal);
  });

  it('reports an abort as a cancellation', async () => {
    const controller = new AbortController();
    const transport = fetchTransport({ fetch: hangingFetch });

    const pending = caught(transport({ ...GET, signal: controller.signal }));
    controller.abort();
    const error = await pending;

    expect(error).toBeInstanceOf(TransportError);
    expect((error as TransportError).message).toBe('Request aborted by the caller');
  });
});
