import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
import {
  ConfigurationError,
  VerificationClient,
  type AuthProvider,
  type AuthRequest,
  type HttpRequest,
  type HttpResponse,
} from '@didww/verification-core';
import { fakeTransport } from '@didww/verification-core/testing';
import { describe, expect, it } from 'vitest';
import { applicationAuth } from './application-auth.js';

const KEY = 'app_signed_only';
const SECRET = 'Vs_4BEq2n7ZBe5nZIUPDAo_9RZfhl8kSBZgkCMMmvNU';
const NON_CANONICAL_SECRET = 'tEsT_secret_urlsafe_base64_value_AB';
const NOW_MS = 1_700_000_000_999;
const clock = (): number => NOW_MS;

const VERIFICATION = JSON.stringify({
  data: {
    id: 'ver_1',
    destination: '15551234567',
    delivery_method: 'sms',
    fee: '0.0345',
    status: 'pending',
    error_code: null,
    error_detail: null,
    expires_at: null,
    sms: null,
  },
});

const ok = (status: number): HttpResponse => ({ status, headers: {}, body: VERIFICATION });

/** Records the `AuthRequest` the client hands the provider, which no recorded header shows. */
function recording(inner: AuthProvider): { auth: AuthProvider; seen: AuthRequest[] } {
  const seen: AuthRequest[] = [];
  return {
    auth: {
      headers: (request) => {
        seen.push(request);
        return inner.headers(request);
      },
    },
    seen,
  };
}

// Rebuilt from the bytes that were actually sent, with `node:crypto` rather than with `Signer` --
// a signature checked by the code that produced it only proves the two halves agree.
function signedIndependently(recorded: HttpRequest): string {
  const body = recorded.body ?? '';
  const contentMd5 =
    body.length === 0 ? '' : createHash('md5').update(body, 'utf8').digest('base64');
  const stringToSign = [
    recorded.method,
    contentMd5,
    recorded.headers['Content-Type'] ?? '',
    `x-timestamp:${recorded.headers['x-timestamp'] ?? ''}`,
    recorded.path,
  ].join('\n');

  return createHmac('sha256', Buffer.from(SECRET, 'base64url'))
    .update(stringToSign, 'utf8')
    .digest('base64');
}

function signatureOf(recorded: HttpRequest): string {
  return (recorded.headers['Authorization'] ?? '').slice(`Application ${KEY}:`.length);
}

function clientWith(
  auth: AuthProvider,
  script: readonly HttpResponse[],
): { client: VerificationClient; requests: readonly HttpRequest[] } {
  const { transport, requests } = fakeTransport(script);
  return {
    client: new VerificationClient({ auth, baseUrl: 'https://verification.example', transport }),
    requests,
  };
}

describe('applicationAuth', () => {
  it('returns the Authorization and x-timestamp headers and no others', async () => {
    const headers = await applicationAuth({ key: KEY, secret: SECRET, clock }).headers({
      method: 'GET',
      path: '/api/v1/verifications/ver_1',
      contentType: '',
      body: '',
    });

    expect(Object.keys(headers).sort()).toEqual(['Authorization', 'x-timestamp']);
    expect(headers['Authorization']).toMatch(new RegExp(`^Application ${KEY}:.+$`));
  });

  it('rejects a non-canonical secret when constructed, not on the first request', () => {
    expect(() => applicationAuth({ key: KEY, secret: NON_CANONICAL_SECRET })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a blank key', () => {
    expect(() => applicationAuth({ key: '   ', secret: SECRET })).toThrow(/must not be blank/);
  });

  it('rejects a key containing a colon, which the server would read as a signature', () => {
    expect(() => applicationAuth({ key: 'app:one', secret: SECRET })).toThrow(/must not contain/);
  });

  it('uses the real clock when none is injected', async () => {
    const before = Math.floor(Date.now() / 1000);
    const headers = await applicationAuth({ key: KEY, secret: SECRET }).headers({
      method: 'GET',
      path: '/api/v1/verifications/ver_1',
      contentType: '',
      body: '',
    });
    const sent = Number(headers['x-timestamp']);

    expect(sent).toBeGreaterThanOrEqual(before);
    expect(sent).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
  });
});

describe('applicationAuth through the client', () => {
  it('signs a bodyless GET over an empty content type and sends no Content-Type at all', async () => {
    const { auth, seen } = recording(applicationAuth({ key: KEY, secret: SECRET, clock }));
    const { client, requests } = clientWith(auth, [ok(200)]);

    await client.getVerification('ver_1');

    const recorded = requests[0]!;
    // Two distinct failures: signing `application/json` while sending nothing, and sending a
    // defaulted header the signature never covered. The server 401s on either.
    expect(seen[0]?.contentType).toBe('');
    expect(Object.keys(recorded.headers)).not.toContain('Content-Type');
    expect(Object.keys(recorded.headers).sort()).toEqual([
      'Accept',
      'Authorization',
      'x-timestamp',
    ]);
    expect(recorded.body).toBeUndefined();
    expect(signatureOf(recorded)).toBe(signedIndependently(recorded));
  });

  it('signs a POST over the exact Content-Type it sends', async () => {
    const { auth, seen } = recording(applicationAuth({ key: KEY, secret: SECRET, clock }));
    const { client, requests } = clientWith(auth, [ok(201)]);

    await client.startVerification({ destination: '+15551234567', deliveryMethod: 'sms' });

    const recorded = requests[0]!;
    expect(seen[0]?.contentType).toBe('application/json');
    expect(recorded.headers['Content-Type']).toBe('application/json');
    expect(Object.keys(recorded.headers).sort()).toEqual([
      'Accept',
      'Authorization',
      'Content-Type',
      'x-timestamp',
    ]);
    expect(seen[0]?.body).toBe(recorded.body);
    expect(signatureOf(recorded)).toBe(signedIndependently(recorded));
  });

  it('signs a PUT report over its own path and body', async () => {
    const { auth } = recording(applicationAuth({ key: KEY, secret: SECRET, clock }));
    const { client, requests } = clientWith(auth, [ok(200)]);

    await client.reportVerification('ver_1', { deliveryMethod: 'sms', code: '123456' });

    const recorded = requests[0]!;
    expect(recorded.method).toBe('PUT');
    expect(recorded.path).toBe('/api/v1/verifications/ver_1');
    expect(signatureOf(recorded)).toBe(signedIndependently(recorded));
  });

  it('sends the injected clock truncated to whole seconds', async () => {
    const auth = applicationAuth({ key: KEY, secret: SECRET, clock });
    const { client, requests } = clientWith(auth, [ok(200)]);

    await client.getVerification('ver_1');

    expect(requests[0]?.headers['x-timestamp']).toBe('1700000000');
  });

  it('signs the timestamp it sends when the clock moves between reads', async () => {
    // A second reading would land a second later, and every request would 401 with a signature
    // both sides compute correctly over different strings.
    let tick = NOW_MS;
    const advancing = (): number => {
      tick += 1_000;
      return tick;
    };
    const auth = applicationAuth({ key: KEY, secret: SECRET, clock: advancing });
    const { client, requests } = clientWith(auth, [ok(200)]);

    await client.getVerification('ver_1');

    const recorded = requests[0]!;
    expect(recorded.headers['x-timestamp']).toBe('1700000001');
    expect(signatureOf(recorded)).toBe(signedIndependently(recorded));
  });

  it('is refused by the client when a provider supplies a Content-Type', async () => {
    const signed = applicationAuth({ key: KEY, secret: SECRET, clock });
    const contentTyped: AuthProvider = {
      headers: async (request) => ({
        ...(await signed.headers(request)),
        'Content-Type': 'application/json',
      }),
    };
    const { client, requests } = clientWith(contentTyped, [ok(200)]);

    await expect(client.getVerification('ver_1')).rejects.toBeInstanceOf(ConfigurationError);
    expect(requests).toHaveLength(0);
  });
});
