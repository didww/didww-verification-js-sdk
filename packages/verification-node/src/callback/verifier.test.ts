import { Buffer } from 'node:buffer';
import { createHash, createHmac } from 'node:crypto';
import { ConfigurationError } from '@didww/verification-core';
import { describe, expect, it } from 'vitest';
import { Signer } from '../signer.js';
import { CallbackVerifier, type SecretSource } from './verifier.js';

const KEY = '3f2a1c60-8b7e-4d21-9c55-0e6b1a7d4f88';
const SECRET = 'tEsT_secret_urlsafe_base64_value_AA';
const OTHER_KEY = 'c1d4e7f0-2a3b-4c5d-6e7f-8a9b0c1d2e3f';
const OTHER_SECRET = 'sEcOnD_application_secret_value_AA';

const PATH = '/didww/verification-callback';
const NOW_SECONDS = 1_700_000_000;
const NOW_MS = NOW_SECONDS * 1000;
const clock = (): number => NOW_MS;

const BODY = JSON.stringify({
  event: 'verification_request',
  data: {
    id: '01920a7b-0000-7000-8000-000000000001',
    destination: '12025550143',
    delivery_method: 'sms',
  },
});

interface Wire {
  method: string;
  path: string;
  contentType: string;
  body: string;
  timestamp: string | null | undefined;
  authorization: string | null | undefined;
}

interface Parts {
  method?: string;
  path?: string;
  contentType?: string;
  body?: string;
  timestamp?: string;
}

/** Builds an inbound callback the way the API emits one, signed with the production `Signer`. */
function signed(parts: Parts = {}, as: { key?: string; secret?: string } = {}): Wire {
  const request = {
    method: parts.method ?? 'POST',
    path: parts.path ?? PATH,
    contentType: parts.contentType ?? 'application/json',
    body: parts.body ?? BODY,
    timestamp: parts.timestamp ?? String(NOW_SECONDS),
  };
  const signature = new Signer(as.secret ?? SECRET).sign(request);
  return { ...request, authorization: `Application ${as.key ?? KEY}:${signature}` };
}

const fixed = new CallbackVerifier({ secret: SECRET, clock });

const applications = new Map([
  [KEY, SECRET],
  [OTHER_KEY, OTHER_SECRET],
]);
const resolving = new CallbackVerifier({
  secret: (key) => applications.get(key) ?? null,
  clock,
});

describe('CallbackVerifier.parseAuthorization', () => {
  it('delegates to the header parser', () => {
    expect(CallbackVerifier.parseAuthorization(`Application ${KEY}:sig`)).toEqual({
      key: KEY,
      signature: 'sig',
    });
    expect(CallbackVerifier.parseAuthorization(null)).toEqual({ key: null, signature: null });
  });
});

describe('CallbackVerifier accepting a callback', () => {
  it('accepts a correctly signed, fresh request and populates the key', async () => {
    const result = await fixed.verify(signed());

    expect(result).toEqual({
      ok: true,
      payload: {
        event: 'verification_request',
        key: KEY,
        data: {
          id: '01920a7b-0000-7000-8000-000000000001',
          destination: '12025550143',
          deliveryMethod: 'sms',
        },
      },
    });
  });

  it('accepts a signature computed outside this SDK', async () => {
    // The oracle: the five lines and the URL-safe secret decoding, recomputed here the way the
    // sending side does it, so the two sides cannot agree by sharing one wrong helper.
    const stringToSign = [
      'POST',
      createHash('md5').update(BODY, 'utf8').digest('base64'),
      'application/json',
      `x-timestamp:${String(NOW_SECONDS)}`,
      PATH,
    ].join('\n');
    const key = Buffer.from(SECRET.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('base64');

    const result = await fixed.verify({
      method: 'POST',
      path: PATH,
      contentType: 'application/json',
      body: BODY,
      timestamp: String(NOW_SECONDS),
      authorization: `Application ${KEY}:${signature}`,
    });

    expect(result.ok).toBe(true);
  });
});

describe('CallbackVerifier timestamp window', () => {
  it.each([
    ['300 seconds in the past', NOW_SECONDS - 300],
    ['299 seconds in the past', NOW_SECONDS - 299],
    ['300 seconds in the future', NOW_SECONDS + 300],
    ['this instant', NOW_SECONDS],
  ])('accepts a timestamp %s', async (_label, seconds) => {
    const result = await fixed.verify(signed({ timestamp: String(seconds) }));

    expect(result.ok).toBe(true);
  });

  it.each([
    ['301 seconds in the past', NOW_SECONDS - 301],
    ['301 seconds in the future', NOW_SECONDS + 301],
  ])('rejects a correctly signed timestamp %s', async (_label, seconds) => {
    const result = await fixed.verify(signed({ timestamp: String(seconds) }));

    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_window', key: KEY });
  });

  it.each([
    ['a missing header', null],
    ['an undefined header', undefined],
    ['an empty header', ''],
    ['a whitespace-only header', '  '],
  ])('reports %s as a missing timestamp', async (_label, timestamp) => {
    const result = await fixed.verify({ ...signed(), timestamp });

    expect(result).toEqual({ ok: false, reason: 'missing_timestamp', key: KEY });
  });

  it.each([
    ['a non-numeric value', 'yesterday'],
    ['milliseconds', String(NOW_MS)],
    ['a negative value', String(-NOW_SECONDS)],
    ['a fractional value', `${String(NOW_SECONDS)}.5`],
    ['a value beyond the safe integer range', '99999999999999999999'],
  ])('reports %s as out of the window rather than missing', async (_label, timestamp) => {
    const result = await fixed.verify({ ...signed(), timestamp });

    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_window', key: KEY });
  });

  it('honours a configured tolerance', async () => {
    const strict = new CallbackVerifier({ secret: SECRET, clock, tolerance: 5 });

    await expect(strict.verify(signed({ timestamp: String(NOW_SECONDS - 5) }))).resolves.toEqual({
      ok: true,
      payload: expect.objectContaining({ key: KEY }),
    });
    await expect(strict.verify(signed({ timestamp: String(NOW_SECONDS - 6) }))).resolves.toEqual({
      ok: false,
      reason: 'timestamp_out_of_window',
      key: KEY,
    });
  });
});

describe('CallbackVerifier rejecting a callback', () => {
  it.each([
    ['a missing header', null],
    ['an undefined header', undefined],
    ['another scheme', 'Basic Zm9vOmJhcg=='],
    ['an empty token', 'Application '],
  ])('reports %s as a missing signature, with no key', async (_label, authorization) => {
    const result = await fixed.verify({ ...signed(), authorization });

    expect(result).toEqual({ ok: false, reason: 'missing_signature', key: null });
  });

  it('reports an unsigned Application header as a missing signature, keeping its key', async () => {
    const result = await fixed.verify({ ...signed(), authorization: `Application ${KEY}` });

    expect(result).toEqual({ ok: false, reason: 'missing_signature', key: KEY });
  });

  it('rejects a wrong signature', async () => {
    const wrong = new Signer(OTHER_SECRET).sign({
      method: 'POST',
      path: PATH,
      contentType: 'application/json',
      body: BODY,
      timestamp: String(NOW_SECONDS),
    });

    const result = await fixed.verify({
      ...signed(),
      authorization: `Application ${KEY}:${wrong}`,
    });

    expect(result).toEqual({ ok: false, reason: 'signature_mismatch', key: KEY });
  });

  it('rejects a body tampered with after signing', async () => {
    const request = signed();
    const tampered = BODY.replace('12025550143', '12025550144');

    const result = await fixed.verify({ ...request, body: tampered });

    expect(result).toEqual({ ok: false, reason: 'signature_mismatch', key: KEY });
  });

  it('rejects a content type a proxy rewrote', async () => {
    const request = signed();

    const result = await fixed.verify({
      ...request,
      contentType: 'application/json; charset=utf-8',
    });

    expect(result).toEqual({ ok: false, reason: 'signature_mismatch', key: KEY });
  });

  it('rejects a correctly signed body that is not the expected envelope', async () => {
    const result = await fixed.verify(signed({ body: 'not json at all' }));

    expect(result).toEqual({ ok: false, reason: 'unparseable_body', key: KEY });
  });
});

describe('CallbackVerifier path handling', () => {
  it('rejects when the registered path is not the one that was signed', async () => {
    // The rewriting-ingress case: valid signatures on both sides, one path apart.
    const result = await fixed.verify({ ...signed({ path: '/a' }), path: '/b' });

    expect(result).toEqual({ ok: false, reason: 'signature_mismatch', key: KEY });
  });

  it('never second-guesses an explicit path against a bare-origin registration', async () => {
    // A pathless registered URL signs '', and the verifier answers about the path it was given.
    const result = await fixed.verify({ ...signed({ path: '' }), path: '/x' });

    expect(result).toEqual({ ok: false, reason: 'signature_mismatch', key: KEY });
  });

  it('rejects a signed "/" verified against ""', async () => {
    // Asserted here rather than on the adapter: `req.path` is never empty in Express, so the
    // adapter cannot reach this direction and a proof there would be theatre.
    const result = await fixed.verify({ ...signed({ path: '/' }), path: '' });

    expect(result).toEqual({ ok: false, reason: 'signature_mismatch', key: KEY });
  });

  it('accepts a bare-origin registration verified against the empty path', async () => {
    const result = await fixed.verify(signed({ path: '' }));

    expect(result.ok).toBe(true);
  });
});

describe('CallbackVerifier body cap', () => {
  const oversized = `{"pad":"${'a'.repeat(8192)}"}`;

  it('reports an oversized unsigned body as too large, before anything else', async () => {
    // Both oversized and unsigned: the reason proves size is checked first.
    const result = await fixed.verify({
      method: 'POST',
      path: PATH,
      contentType: 'application/json',
      body: oversized,
      timestamp: null,
      authorization: null,
    });

    expect(result).toEqual({ ok: false, reason: 'body_too_large', key: null });
  });

  it('rejects an oversized body even when it is correctly signed', async () => {
    const result = await fixed.verify(signed({ body: oversized }));

    expect(result).toEqual({ ok: false, reason: 'body_too_large', key: KEY });
  });

  it('measures the cap in bytes, not characters', async () => {
    // 4096 characters, 12288 bytes: a character count would wave this straight through.
    const multibyte = '€'.repeat(4096);

    const result = await fixed.verify(signed({ body: multibyte }));

    expect(result).toEqual({ ok: false, reason: 'body_too_large', key: KEY });
  });

  it('admits a body of exactly the cap', async () => {
    const exact = `"${'a'.repeat(8190)}"`;
    expect(Buffer.byteLength(exact, 'utf8')).toBe(8192);

    // It clears the size check, and it is correctly signed, so the reason comes from the last one.
    const result = await fixed.verify(signed({ body: exact }));

    expect(result).toEqual({ ok: false, reason: 'unparseable_body', key: KEY });
  });

  it('honours a configured cap', async () => {
    const tight = new CallbackVerifier({ secret: SECRET, clock, maxBodyBytes: 8 });

    await expect(tight.verify(signed())).resolves.toEqual({
      ok: false,
      reason: 'body_too_large',
      key: KEY,
    });
  });
});

describe('CallbackVerifier check order', () => {
  it('reports an unparseable, mis-signed body as a signature mismatch', async () => {
    // Parsing runs last, so an attacker's garbage never reaches the JSON reader.
    const request = signed({ body: 'not json at all' });

    const result = await fixed.verify({ ...request, body: 'not json either' });

    expect(result).toEqual({ ok: false, reason: 'signature_mismatch', key: KEY });
  });

  it('reports a stale timestamp on an unknown key as out of the window', async () => {
    const result = await resolving.verify(
      signed({ timestamp: String(NOW_SECONDS - 400) }, { key: 'nobody' }),
    );

    expect(result).toEqual({ ok: false, reason: 'timestamp_out_of_window', key: 'nobody' });
  });

  it('reports an unknown key on a tampered body as an unknown key', async () => {
    const request = signed({}, { key: 'nobody' });

    const result = await resolving.verify({ ...request, body: '{}' });

    expect(result).toEqual({ ok: false, reason: 'unknown_key', key: 'nobody' });
  });

  it('reports an oversized body with no timestamp as too large', async () => {
    const result = await fixed.verify({ ...signed({ body: 'x'.repeat(9000) }), timestamp: null });

    expect(result).toEqual({ ok: false, reason: 'body_too_large', key: KEY });
  });
});

describe('CallbackVerifier secret sources', () => {
  it('selects the secret per key', async () => {
    await expect(resolving.verify(signed())).resolves.toEqual({
      ok: true,
      payload: expect.objectContaining({ key: KEY }),
    });
    await expect(
      resolving.verify(signed({}, { key: OTHER_KEY, secret: OTHER_SECRET })),
    ).resolves.toEqual({ ok: true, payload: expect.objectContaining({ key: OTHER_KEY }) });
  });

  it('rejects one application signing as another', async () => {
    const result = await resolving.verify(signed({}, { key: KEY, secret: OTHER_SECRET }));

    expect(result).toEqual({ ok: false, reason: 'signature_mismatch', key: KEY });
  });

  it('reports an unknown key when the resolver returns null', async () => {
    const verifier = new CallbackVerifier({ secret: () => null, clock });

    await expect(verifier.verify(signed())).resolves.toEqual({
      ok: false,
      reason: 'unknown_key',
      key: KEY,
    });
  });

  it('reports an unknown key when the resolver misses and returns undefined', async () => {
    // A plain `Map.get` miss. Declared `string | null`, but the crash would be at runtime.
    const store = new Map([[OTHER_KEY, OTHER_SECRET]]);
    const secret: SecretSource = (key) => store.get(key) as string | null;
    const verifier = new CallbackVerifier({ secret, clock });

    await expect(verifier.verify(signed())).resolves.toEqual({
      ok: false,
      reason: 'unknown_key',
      key: KEY,
    });
  });

  it('awaits a resolver that returns a promise', async () => {
    const verifier = new CallbackVerifier({
      secret: (key) => Promise.resolve(key === KEY ? SECRET : null),
      clock,
    });

    await expect(verifier.verify(signed())).resolves.toEqual({
      ok: true,
      payload: expect.objectContaining({ key: KEY }),
    });
    await expect(verifier.verify(signed({}, { key: 'nobody' }))).resolves.toEqual({
      ok: false,
      reason: 'unknown_key',
      key: 'nobody',
    });
  });

  it('accepts any key under a fixed secret, and so never reports an unknown one', async () => {
    const result = await fixed.verify(signed({}, { key: 'whoever' }));

    expect(result).toEqual({ ok: true, payload: expect.objectContaining({ key: 'whoever' }) });
  });

  it('lets a resolver failure through rather than answering 401', async () => {
    const verifier = new CallbackVerifier({
      secret: () => {
        throw new Error('secret store unreachable');
      },
      clock,
    });

    await expect(verifier.verify(signed())).rejects.toThrow('secret store unreachable');
  });

  it('rejects a blank resolved secret loudly', async () => {
    const verifier = new CallbackVerifier({ secret: () => '', clock });

    await expect(verifier.verify(signed())).rejects.toThrow(ConfigurationError);
  });

  it('rejects a malformed fixed secret at construction, before any callback arrives', () => {
    expect(() => new CallbackVerifier({ secret: 'tEsT+secret/value_AA' })).toThrow(
      ConfigurationError,
    );
  });

  it('defaults its clock to the host clock', async () => {
    const live = new CallbackVerifier({ secret: SECRET });

    const result = await live.verify(signed({ timestamp: String(Math.floor(Date.now() / 1000)) }));

    expect(result.ok).toBe(true);
  });
});
