import { describe, expect, it, vi } from 'vitest';
import type { AuthProvider, AuthRequest } from './auth.js';
import { PRODUCTION_BASE_URL, SANDBOX_BASE_URL, VerificationClient } from './client.js';
import {
  BalanceInsufficientError,
  ChannelMismatchError,
  ConfigurationError,
  NotFoundError,
  ServerError,
  TransportError,
  UnauthorizedError,
  ValidationError,
} from './errors.js';
import { INTERNAL_APP_HASH_KEY, type ClientOptions, type InternalSmsOptions } from './options.js';
import { fakeTransport } from './testing/index.js';
import type { HttpRequest, HttpResponse, Transport } from './transport.js';

const DESTINATION = '+4915112345678';
const VALID_APP_HASH = 'abcdEFGH+/1';

const PAYLOAD = {
  id: 'ver-1',
  destination: DESTINATION,
  delivery_method: 'sms',
  fee: '0.0345',
  status: 'pending',
  error_code: null,
  error_detail: null,
  expires_at: '2026-08-25T10:00:00Z',
  sms: {
    template: 'Your code is {code}',
    language: 'en-US',
    interception_timeout: 120,
    app_hash: null,
  },
};

const OK: HttpResponse = { status: 200, headers: {}, body: JSON.stringify({ data: PAYLOAD }) };
const CREATED: HttpResponse = { ...OK, status: 201 };

const STATIC_AUTH: AuthProvider = { headers: () => ({ Authorization: 'Application test-key' }) };

type ExtraOptions = Omit<Partial<ClientOptions>, 'auth' | 'transport'>;
type Script = ReadonlyArray<HttpResponse | ((request: HttpRequest) => HttpResponse)>;

function setup(script: Script, extra: ExtraOptions = {}) {
  const { transport, requests } = fakeTransport(script);
  const authRequests: AuthRequest[] = [];
  const auth: AuthProvider = {
    headers: (request) => {
      authRequests.push(request);
      return { Authorization: 'Application test-key' };
    },
  };
  return {
    client: new VerificationClient({ auth, transport, ...extra }),
    requests,
    authRequests,
  };
}

function alwaysFailing(): { transport: Transport; requests: readonly HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    transport: (request) => {
      requests.push(request);
      return Promise.reject(new TransportError('network down'));
    },
    requests,
  };
}

function only(requests: readonly HttpRequest[]): HttpRequest {
  expect(requests).toHaveLength(1);
  return requests[0] as HttpRequest;
}

function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

describe('base URLs', () => {
  it('defaults to production', async () => {
    const { client, requests } = setup([CREATED]);
    await client.startVerification({ destination: DESTINATION, deliveryMethod: 'sms' });
    expect(only(requests).url).toBe(`${PRODUCTION_BASE_URL}/api/v1/verifications`);
  });

  it('honours the sandbox environment', async () => {
    const { client, requests } = setup([CREATED], { environment: 'sandbox' });
    await client.startVerification({ destination: DESTINATION, deliveryMethod: 'sms' });
    expect(only(requests).url).toBe(`${SANDBOX_BASE_URL}/api/v1/verifications`);
  });

  it('lets an explicit baseUrl win over the environment', async () => {
    const { client, requests } = setup([OK], {
      environment: 'sandbox',
      baseUrl: 'https://verification.example.test',
    });
    await client.getVerification('ver-1');
    expect(only(requests).url).toBe('https://verification.example.test/api/v1/verifications/ver-1');
  });

  it.each(['https://verification.example.test/gw', 'https://verification.example.test/gw/'])(
    'keeps the path prefix of %s in both the url and the signed path',
    async (baseUrl) => {
      const { client, requests, authRequests } = setup([OK], { baseUrl });
      await client.getVerification('ver-1');

      const request = only(requests);
      expect(request.url).toBe('https://verification.example.test/gw/api/v1/verifications/ver-1');
      expect(request.path).toBe('/gw/api/v1/verifications/ver-1');
      expect(authRequests[0]?.path).toBe(request.path);
    },
  );

  it('refuses a baseUrl that is not an absolute URL', () => {
    expect(() => new VerificationClient({ auth: STATIC_AUTH, baseUrl: '/api/v1' })).toThrow(
      ConfigurationError,
    );
  });
});

describe('routes', () => {
  it('starts a verification', async () => {
    const { client, requests } = setup([CREATED]);
    await client.startVerification({ destination: DESTINATION, deliveryMethod: 'sms' });

    const request = only(requests);
    expect(request.method).toBe('POST');
    expect(request.url).toBe('https://verification.didww.com/api/v1/verifications');
    expect(request.path).toBe('/api/v1/verifications');
    expect(request.body).toBe('{"data":{"destination":"+4915112345678","delivery_method":"sms"}}');
  });

  it('reports a verification by id with PUT', async () => {
    const { client, requests } = setup([OK]);
    await client.reportVerification('ver-1', { deliveryMethod: 'sms', code: '123456' });

    const request = only(requests);
    expect(request.method).toBe('PUT');
    expect(request.url).toBe('https://verification.didww.com/api/v1/verifications/ver-1');
    expect(request.path).toBe('/api/v1/verifications/ver-1');
    expect(request.body).toBe('{"data":{"delivery_method":"sms","code":"123456"}}');
  });

  it('gets a verification by id', async () => {
    const { client, requests } = setup([OK]);
    await client.getVerification('ver-1');

    const request = only(requests);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('https://verification.didww.com/api/v1/verifications/ver-1');
    expect(request.path).toBe('/api/v1/verifications/ver-1');
    expect(request.body).toBeUndefined();
  });

  it('reports a verification by number with PUT', async () => {
    const { client, requests } = setup([OK]);
    await client.reportVerificationByNumber(DESTINATION, {
      deliveryMethod: 'callout',
      code: '123456',
    });

    const request = only(requests);
    expect(request.method).toBe('PUT');
    expect(request.url).toBe(
      'https://verification.didww.com/api/v1/verifications/by_number/4915112345678',
    );
    expect(request.path).toBe('/api/v1/verifications/by_number/4915112345678');
    expect(request.body).toBe('{"data":{"delivery_method":"callout","code":"123456"}}');
  });

  it('gets a verification by number', async () => {
    const { client, requests } = setup([OK]);
    await client.getVerificationByNumber(DESTINATION);

    const request = only(requests);
    expect(request.method).toBe('GET');
    expect(request.url).toBe(
      'https://verification.didww.com/api/v1/verifications/by_number/4915112345678',
    );
    expect(request.path).toBe('/api/v1/verifications/by_number/4915112345678');
    expect(request.body).toBeUndefined();
  });

  it('reports a raw channel by id with PUT and no channel guard', async () => {
    const { client, requests } = setup([OK]);
    await client.reportVerificationRaw('ver-1', {
      deliveryMethod: 'carrier_pigeon',
      code: '123456',
    });

    const request = only(requests);
    expect(request.method).toBe('PUT');
    expect(request.url).toBe('https://verification.didww.com/api/v1/verifications/ver-1');
    expect(request.path).toBe('/api/v1/verifications/ver-1');
    expect(request.body).toBe('{"data":{"delivery_method":"carrier_pigeon","code":"123456"}}');
  });

  it('reports a raw channel by number with PUT and no channel guard', async () => {
    const { client, requests } = setup([OK]);
    await client.reportVerificationRawByNumber(DESTINATION, {
      deliveryMethod: 'carrier_pigeon',
      cli: '+4915199999',
    });

    const request = only(requests);
    expect(request.method).toBe('PUT');
    expect(request.url).toBe(
      'https://verification.didww.com/api/v1/verifications/by_number/4915112345678',
    );
    expect(request.path).toBe('/api/v1/verifications/by_number/4915112345678');
    expect(request.body).toBe('{"data":{"delivery_method":"carrier_pigeon","cli":"+4915199999"}}');
  });
});

describe('path derivation', () => {
  it('percent-encodes the id segment in the url and in the signed path alike', async () => {
    const { client, requests, authRequests } = setup([OK]);
    await client.getVerification('a/b');

    const request = only(requests);
    expect(request.url).toBe('https://verification.didww.com/api/v1/verifications/a%2Fb');
    expect(request.path).toBe('/api/v1/verifications/a%2Fb');
    expect(new URL(request.url).pathname).toBe(request.path);
    expect(authRequests[0]?.path).toBe(request.path);
  });

  it.each([
    ['a b', '/api/v1/verifications/a%20b'],
    ['../admin', '/api/v1/verifications/..%2Fadmin'],
    ['ver 1?x=1', '/api/v1/verifications/ver%201%3Fx%3D1'],
  ])('encodes %j as %s', async (id, path) => {
    const { client, requests } = setup([OK]);
    await client.getVerification(id);

    const request = only(requests);
    expect(request.path).toBe(path);
    expect(new URL(request.url).pathname).toBe(request.path);
  });

  it('reduces a by-number segment to ASCII digits', async () => {
    const { client, requests } = setup([OK]);
    await client.getVerificationByNumber('+49 (151) 1.234');

    const request = only(requests);
    expect(request.path).toBe('/api/v1/verifications/by_number/491511234');
    expect(request.url).toBe(
      'https://verification.didww.com/api/v1/verifications/by_number/491511234',
    );
  });

  it('rejects a destination with no digits before any request', async () => {
    const { client, requests } = setup([OK]);
    await expect(client.getVerificationByNumber('not a number')).rejects.toBeInstanceOf(
      ConfigurationError,
    );
    expect(requests).toEqual([]);
  });
});

describe('the bodyless-request invariant', () => {
  it('sends no Content-Type on a GET and no body property at all', async () => {
    const { client, requests } = setup([OK]);
    await client.getVerification('ver-1');

    const request = only(requests);
    expect('Content-Type' in request.headers).toBe(false);
    expect(Object.keys(request.headers).map((name) => name.toLowerCase())).not.toContain(
      'content-type',
    );
    expect(request.body).toBeUndefined();
    expect('body' in request).toBe(false);
  });

  it("hands the auth provider '' as the content type on a GET", async () => {
    const { client, authRequests } = setup([OK]);
    await client.getVerification('ver-1');

    expect(authRequests).toEqual([
      {
        method: 'GET',
        path: '/api/v1/verifications/ver-1',
        contentType: '',
        body: '',
      },
    ]);
  });

  it('hands the auth provider the exact Content-Type it then sends on a POST', async () => {
    const { client, requests, authRequests } = setup([CREATED]);
    await client.startVerification({ destination: DESTINATION, deliveryMethod: 'sms' });

    const request = only(requests);
    const authRequest = authRequests[0];
    expect(authRequest?.contentType).toBe('application/json');
    expect(request.headers['Content-Type']).toBe(authRequest?.contentType);
    expect(authRequest?.body).toBe(request.body);
    expect(authRequest?.method).toBe(request.method);
  });

  it('refuses a Content-Type returned by the AuthProvider on a bodyless GET', async () => {
    const { transport, requests } = fakeTransport([OK]);
    const auth: AuthProvider = {
      headers: () => ({
        Authorization: 'Application test-key',
        'Content-Type': 'application/json',
      }),
    };
    const client = new VerificationClient({ auth, transport, retry: { attempts: 1 } });

    await expect(client.getVerification('ver-1')).rejects.toBeInstanceOf(ConfigurationError);
    expect(requests).toEqual([]);
  });

  it.each(['Content-Type', 'content-type', 'CONTENT-TYPE'])(
    'refuses a %s from the AuthProvider on a POST too, where the header list would join it',
    async (headerName) => {
      const { transport, requests } = fakeTransport([CREATED]);
      const auth: AuthProvider = {
        headers: () => ({ Authorization: 'Application test-key', [headerName]: 'text/plain' }),
      };
      const client = new VerificationClient({ auth, transport });

      await expect(
        client.startVerification({ destination: DESTINATION, deliveryMethod: 'sms' }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(requests).toEqual([]);
    },
  );

  it('awaits an async auth provider before the request is issued', async () => {
    const { transport, requests } = fakeTransport([OK]);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const auth: AuthProvider = {
      headers: async () => {
        await gate;
        return { Authorization: 'Application test-key' };
      },
    };

    const client = new VerificationClient({ auth, transport });
    const pending = client.getVerification('ver-1');
    await Promise.resolve();
    expect(requests).toEqual([]);

    release();
    await pending;
    expect(only(requests).headers['Authorization']).toBe('Application test-key');
  });
});

describe('headers', () => {
  it('sends a User-Agent only when one was configured', async () => {
    const withAgent = setup([OK], { userAgent: 'demo/1.0' });
    await withAgent.client.getVerification('ver-1');
    expect(only(withAgent.requests).headers['User-Agent']).toBe('demo/1.0');

    const withoutAgent = setup([OK]);
    await withoutAgent.client.getVerification('ver-1');
    expect('User-Agent' in only(withoutAgent.requests).headers).toBe(false);
  });

  it('always asks for JSON', async () => {
    const { client, requests } = setup([OK]);
    await client.getVerification('ver-1');
    expect(only(requests).headers['Accept']).toBe('application/json');
  });
});

describe('the channel guard', () => {
  it.each([
    ['sms', { deliveryMethod: 'sms', cli: '+4915199999' }, 'code'],
    ['callout', { deliveryMethod: 'callout', cli: '+4915199999' }, 'code'],
  ])('throws on a known wrong pairing for %s', async (method, options, expectedField) => {
    const { client, requests } = setup([OK]);

    const failure = await failureOf(client.reportVerification('ver-1', options as never));
    expect(failure).toBeInstanceOf(ChannelMismatchError);
    expect(failure).toMatchObject({ expected: method });
    expect(String(failure)).toContain(`\`${expectedField}\``);
    expect(requests).toEqual([]);
  });

  it('applies to the by-number report too', async () => {
    const { client, requests } = setup([OK]);
    await expect(
      client.reportVerificationByNumber(DESTINATION, {
        deliveryMethod: 'sms',
        cli: '+4915199999',
      } as never),
    ).rejects.toBeInstanceOf(ChannelMismatchError);
    expect(requests).toEqual([]);
  });

  it('does not throw on a channel this release does not model', async () => {
    const { client, requests } = setup([OK]);
    await client.reportVerification('ver-1', {
      deliveryMethod: 'carrier_pigeon',
      cli: '+4915199999',
    } as never);

    expect(only(requests).body).toBe(
      '{"data":{"delivery_method":"carrier_pigeon","cli":"+4915199999"}}',
    );
  });

  it('never runs on the raw escape hatch', async () => {
    const { client, requests } = setup([OK]);
    await client.reportVerificationRaw('ver-1', { deliveryMethod: 'sms', cli: '+4915199999' });
    expect(only(requests).body).toBe('{"data":{"delivery_method":"sms","cli":"+4915199999"}}');
  });

  it('leaves the value field off the wire when neither was supplied', async () => {
    const { client, requests } = setup([OK]);
    await client.reportVerification('ver-1', { deliveryMethod: 'sms' } as never);
    expect(only(requests).body).toBe('{"data":{"delivery_method":"sms"}}');
  });
});

describe('the app-hash gate', () => {
  it.each(['too-short', 'twelvechars1', 'abcdEFGH+/=', '', 'abcdEFGH+/-'])(
    'refuses %j before any request is issued',
    async (appHash) => {
      const { client, requests } = setup([CREATED]);
      const sms: InternalSmsOptions = { [INTERNAL_APP_HASH_KEY]: appHash };

      await expect(
        client.startVerification({ destination: DESTINATION, deliveryMethod: 'sms', sms }),
      ).rejects.toBeInstanceOf(ConfigurationError);
      expect(requests).toEqual([]);
    },
  );

  it('refuses a value that is not a string', async () => {
    const { client, requests } = setup([CREATED]);
    const sms = { [INTERNAL_APP_HASH_KEY]: 12345678901 } as unknown as InternalSmsOptions;

    await expect(
      client.startVerification({ destination: DESTINATION, deliveryMethod: 'sms', sms }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(requests).toEqual([]);
  });

  it('emits a well-formed hash as app_hash and never leaks the internal key', async () => {
    const { client, requests } = setup([CREATED]);
    const sms: InternalSmsOptions = {
      languages: ['en-US', 'de-DE'],
      [INTERNAL_APP_HASH_KEY]: VALID_APP_HASH,
    };

    await client.startVerification({ destination: DESTINATION, deliveryMethod: 'sms', sms });

    const request = only(requests);
    expect(request.body).toBe(
      '{"data":{"destination":"+4915112345678","delivery_method":"sms",' +
        '"sms":{"languages":["en-US","de-DE"],"app_hash":"abcdEFGH+/1"}}}',
    );
    expect(request.body).not.toContain(INTERNAL_APP_HASH_KEY);
    expect(request.body).not.toContain('appHash');
  });

  it('runs on a channel whose options block is never sent', async () => {
    const { client, requests } = setup([CREATED]);
    const sms: InternalSmsOptions = { [INTERNAL_APP_HASH_KEY]: 'too-short' };

    await expect(
      client.startVerification({ destination: DESTINATION, deliveryMethod: 'callout', sms }),
    ).rejects.toBeInstanceOf(ConfigurationError);
    expect(requests).toEqual([]);
  });
});

describe('the start body', () => {
  it('sends languages inside the sms block', async () => {
    const { client, requests } = setup([CREATED]);
    await client.startVerification({
      destination: DESTINATION,
      deliveryMethod: 'sms',
      sms: { languages: ['pl-PL'] },
    });

    expect(only(requests).body).toBe(
      '{"data":{"destination":"+4915112345678","delivery_method":"sms","sms":{"languages":["pl-PL"]}}}',
    );
  });

  it('omits an empty sms block', async () => {
    const { client, requests } = setup([CREATED]);
    await client.startVerification({ destination: DESTINATION, deliveryMethod: 'sms', sms: {} });

    expect(only(requests).body).toBe(
      '{"data":{"destination":"+4915112345678","delivery_method":"sms"}}',
    );
  });

  it('sends languages inside the callout block', async () => {
    const { client, requests } = setup([CREATED]);
    await client.startVerification({
      destination: DESTINATION,
      deliveryMethod: 'callout',
      callout: { languages: ['pt-BR', 'pt-PT'] },
    });

    expect(only(requests).body).toBe(
      '{"data":{"destination":"+4915112345678","delivery_method":"callout",' +
        '"callout":{"languages":["pt-BR","pt-PT"]}}}',
    );
  });

  it('omits an empty callout block', async () => {
    const { client, requests } = setup([CREATED]);
    await client.startVerification({
      destination: DESTINATION,
      deliveryMethod: 'callout',
      callout: {},
    });

    expect(only(requests).body).toBe(
      '{"data":{"destination":"+4915112345678","delivery_method":"callout"}}',
    );
  });

  it('omits the callout block on a channel that does not read it', async () => {
    const { client, requests } = setup([CREATED]);
    await client.startVerification({
      destination: DESTINATION,
      deliveryMethod: 'sms',
      callout: { languages: ['pt-PT'] },
    });

    expect(only(requests).body).toBe(
      '{"data":{"destination":"+4915112345678","delivery_method":"sms"}}',
    );
  });

  it('emits only the block the channel reads when both were supplied', async () => {
    const { client, requests } = setup([CREATED]);
    await client.startVerification({
      destination: DESTINATION,
      deliveryMethod: 'callout',
      sms: { languages: ['de-DE'] },
      callout: { languages: ['pt-PT'] },
    });

    expect(only(requests).body).toBe(
      '{"data":{"destination":"+4915112345678","delivery_method":"callout",' +
        '"callout":{"languages":["pt-PT"]}}}',
    );
  });

  it('omits the sms block on a channel that does not read it', async () => {
    const { client, requests } = setup([CREATED]);
    await client.startVerification({
      destination: DESTINATION,
      deliveryMethod: 'callout',
      sms: { languages: ['en-US'] },
    });

    expect(only(requests).body).toBe(
      '{"data":{"destination":"+4915112345678","delivery_method":"callout"}}',
    );
  });

  it('writes an unmodelled channel through unchanged', async () => {
    const { client, requests } = setup([CREATED]);
    await client.startVerification({ destination: DESTINATION, deliveryMethod: 'carrier_pigeon' });

    expect(only(requests).body).toBe(
      '{"data":{"destination":"+4915112345678","delivery_method":"carrier_pigeon"}}',
    );
  });
});

describe('retry', () => {
  const writeCalls: ReadonlyArray<[string, (client: VerificationClient) => Promise<unknown>]> = [
    [
      'startVerification',
      (client) => client.startVerification({ destination: DESTINATION, deliveryMethod: 'sms' }),
    ],
    [
      'reportVerification',
      (client) => client.reportVerification('ver-1', { deliveryMethod: 'sms', code: '123456' }),
    ],
    [
      'reportVerificationByNumber',
      (client) =>
        client.reportVerificationByNumber(DESTINATION, { deliveryMethod: 'sms', code: '123456' }),
    ],
    [
      'reportVerificationRaw',
      (client) =>
        client.reportVerificationRaw('ver-1', { deliveryMethod: 'carrier_pigeon', code: '123456' }),
    ],
    [
      'reportVerificationRawByNumber',
      (client) =>
        client.reportVerificationRawByNumber(DESTINATION, {
          deliveryMethod: 'carrier_pigeon',
          code: '123456',
        }),
    ],
  ];

  it.each(writeCalls)('never retries %s, whatever the policy says', async (_name, call) => {
    const { transport, requests } = alwaysFailing();
    const client = new VerificationClient({
      auth: STATIC_AUTH,
      transport,
      retry: { attempts: 10, baseDelayMs: 0 },
    });

    await expect(call(client)).rejects.toBeInstanceOf(TransportError);
    expect(requests).toHaveLength(1);
  });

  it.each(writeCalls)('never retries %s on a 5xx either', async (_name, call) => {
    const requests: HttpRequest[] = [];
    const transport: Transport = (request) => {
      requests.push(request);
      return Promise.resolve({ status: 503, headers: {}, body: '{"errors":[]}' });
    };
    const client = new VerificationClient({
      auth: STATIC_AUTH,
      transport,
      retry: { attempts: 10, baseDelayMs: 0 },
    });

    await expect(call(client)).rejects.toBeInstanceOf(ServerError);
    expect(requests).toHaveLength(1);
  });

  it('retries a GET twice by default, on the default backoff', async () => {
    vi.useFakeTimers();
    try {
      const { transport, requests } = alwaysFailing();
      const client = new VerificationClient({ auth: STATIC_AUTH, transport });

      const pending = client.getVerification('ver-1');
      const settled = expect(pending).rejects.toBeInstanceOf(TransportError);
      await vi.advanceTimersByTimeAsync(1_000);
      await settled;

      expect(requests).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('makes exactly one attempt when the policy says one', async () => {
    const { transport, requests } = alwaysFailing();
    const client = new VerificationClient({
      auth: STATIC_AUTH,
      transport,
      retry: { attempts: 1 },
    });

    await expect(client.getVerification('ver-1')).rejects.toBeInstanceOf(TransportError);
    expect(requests).toHaveLength(1);
  });

  it('recovers a GET after a 5xx', async () => {
    const { client, requests } = setup([{ status: 503, headers: {}, body: '{"errors":[]}' }, OK], {
      retry: { attempts: 2, baseDelayMs: 0 },
    });

    await expect(client.getVerification('ver-1')).resolves.toMatchObject({ id: 'ver-1' });
    expect(requests).toHaveLength(2);
  });

  it('does not retry a GET that failed with a 4xx', async () => {
    const { client, requests } = setup([{ status: 404, headers: {}, body: '{"errors":[]}' }], {
      retry: { attempts: 5, baseDelayMs: 0 },
    });

    await expect(client.getVerification('ver-1')).rejects.toBeInstanceOf(NotFoundError);
    expect(requests).toHaveLength(1);
  });
});

describe('responses', () => {
  it('decodes a verification', async () => {
    const { client } = setup([OK]);
    await expect(client.getVerification('ver-1')).resolves.toEqual({
      id: 'ver-1',
      destination: DESTINATION,
      deliveryMethod: 'sms',
      fee: '0.0345',
      status: 'pending',
      errorCode: null,
      errorDetail: null,
      expiresAt: new Date('2026-08-25T10:00:00Z'),
      sms: {
        template: 'Your code is {code}',
        language: 'en-US',
        interceptionTimeoutSeconds: 120,
        appHash: null,
      },
      callout: null,
    });
  });

  it('keeps the raw payload only when asked', async () => {
    const kept = setup([OK], { keepRawPayload: true });
    await expect(kept.client.getVerification('ver-1')).resolves.toMatchObject({
      unsafeRawPayload: PAYLOAD,
    });

    const dropped = setup([OK]);
    expect((await dropped.client.getVerification('ver-1')).unsafeRawPayload).toBeUndefined();
  });

  it.each([
    [400, ValidationError],
    [401, UnauthorizedError],
    [402, BalanceInsufficientError],
    [404, NotFoundError],
    [422, ValidationError],
    [500, ServerError],
  ])('turns %s into its error class, carrying the decoded envelope', async (status, expected) => {
    const body = JSON.stringify({
      errors: [{ code: 'code_invalid', detail: 'The code is wrong.' }],
    });
    const { client } = setup([{ status, headers: {}, body }], { retry: { attempts: 1 } });

    const failure = await failureOf(client.getVerification('ver-1'));
    expect(failure).toBeInstanceOf(expected);
    expect(failure).toMatchObject({
      status,
      code: 'code_invalid',
      codes: ['code_invalid'],
      errors: [{ code: 'code_invalid', detail: 'The code is wrong.' }],
      responseBody: body,
    });
  });

  it('classifies an error body that is not this API envelope at all', async () => {
    const body = '<html>502 Bad Gateway</html>';
    const { client } = setup([{ status: 502, headers: {}, body }], { retry: { attempts: 1 } });

    const failure = await failureOf(client.getVerification('ver-1'));
    expect(failure).toBeInstanceOf(ServerError);
    expect(failure).toMatchObject({ status: 502, code: null, errors: [], responseBody: body });
  });
});

describe('the abort signal', () => {
  it('is forwarded to the transport when given', async () => {
    const controller = new AbortController();
    const { client, requests } = setup([OK]);
    await client.getVerification('ver-1', { signal: controller.signal });
    expect(only(requests).signal).toBe(controller.signal);
  });

  it('is forwarded from a report too', async () => {
    const controller = new AbortController();
    const { client, requests } = setup([OK]);
    await client.reportVerification('ver-1', {
      deliveryMethod: 'sms',
      code: '123456',
      signal: controller.signal,
    });
    expect(only(requests).signal).toBe(controller.signal);
  });

  it('is forwarded from a start too', async () => {
    const controller = new AbortController();
    const { client, requests } = setup([CREATED]);
    await client.startVerification({
      destination: DESTINATION,
      deliveryMethod: 'sms',
      signal: controller.signal,
    });
    expect(only(requests).signal).toBe(controller.signal);
  });

  it('is absent from the request when none was given', async () => {
    const { client, requests } = setup([OK]);
    await client.getVerification('ver-1');
    expect('signal' in only(requests)).toBe(false);
  });
});

describe('logging', () => {
  it('logs method, url and status, and no body', async () => {
    const lines: string[] = [];
    const { client } = setup([CREATED], { logger: (line) => lines.push(line) });
    await client.startVerification({ destination: DESTINATION, deliveryMethod: 'sms' });

    expect(lines).toEqual(['POST https://verification.didww.com/api/v1/verifications -> 201']);
    expect(lines[0]).not.toContain(DESTINATION);
  });

  it('masks the destination in a by-number line', async () => {
    const lines: string[] = [];
    const { client } = setup([OK], { logger: (line) => lines.push(line) });
    await client.getVerificationByNumber('+49 151 1234567');

    expect(lines).toEqual([
      'GET https://verification.didww.com/api/v1/verifications/by_number/[redacted] -> 200',
    ]);
    expect(lines[0]).not.toContain('491511234567');
  });

  it('logs a transport failure without a status', async () => {
    const lines: string[] = [];
    const { transport } = alwaysFailing();
    const client = new VerificationClient({
      auth: STATIC_AUTH,
      transport,
      retry: { attempts: 1 },
      logger: (line) => lines.push(line),
    });

    await expect(client.getVerification('ver-1')).rejects.toBeInstanceOf(TransportError);
    expect(lines).toEqual([
      'GET https://verification.didww.com/api/v1/verifications/ver-1 -> transport error',
    ]);
  });
});

describe('the default transport', () => {
  it('goes to fetch, with the configured timeout', async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchStub = vi.fn((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response(OK.body, { status: 200 }));
    });
    vi.stubGlobal('fetch', fetchStub);

    try {
      const client = new VerificationClient({ auth: STATIC_AUTH, timeoutMs: 1_000 });
      await expect(client.getVerification('ver-1')).resolves.toMatchObject({ id: 'ver-1' });

      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('https://verification.didww.com/api/v1/verifications/ver-1');
      expect(calls[0]?.init?.method).toBe('GET');
      expect(calls[0]?.init?.signal).toBeDefined();

      const defaulted = new VerificationClient({ auth: STATIC_AUTH });
      await expect(defaulted.getVerification('ver-1')).resolves.toMatchObject({ id: 'ver-1' });
      expect(calls).toHaveLength(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
