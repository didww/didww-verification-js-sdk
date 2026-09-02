import { describe, expect, it } from 'vitest';
import { DecodingError } from './errors.js';
import { decodeErrorEnvelope, decodeVerificationEnvelope } from './wire.js';

const smsCreate: Record<string, unknown> = {
  id: '01997b8e-7f52-7c1a-9d3e-2a4f6b8c0d11',
  destination: '37112345678',
  delivery_method: 'sms',
  fee: '0.0345',
  status: 'pending',
  error_code: null,
  error_detail: null,
  expires_at: '2026-08-25T12:00:00.000Z',
  sms: {
    template: 'Your verification code is {code}',
    language: 'de-DE',
    interception_timeout: 120,
    app_hash: 'FA+9qCX9VSu',
  },
};

const calloutCreate: Record<string, unknown> = {
  id: '01997b8e-9b21-7d55-a3e8-62ea01b4c733',
  destination: '351912345678',
  delivery_method: 'callout',
  fee: '0.0210',
  status: 'pending',
  error_code: null,
  error_detail: null,
  expires_at: '2026-08-25T12:00:00.000Z',
  callout: { language: 'pt-PT' },
};

const noSmsBlockCreate: Record<string, unknown> = {
  id: '01997b8e-8a10-7f44-b2c7-51d9e0a3f622',
  destination: '4915112345678',
  delivery_method: 'carrier_pigeon',
  fee: '0.0120',
  status: 'pending',
  error_code: null,
  error_detail: null,
  expires_at: '2026-08-25T12:00:00.000Z',
};

function body(data: Record<string, unknown>): string {
  return JSON.stringify({ data });
}

function decodingErrorFrom(run: () => unknown): DecodingError {
  try {
    run();
  } catch (error) {
    if (error instanceof DecodingError) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected a DecodingError, none was thrown.');
}

describe('decodeVerificationEnvelope', () => {
  it('decodes an sms create, sms block included', () => {
    const verification = decodeVerificationEnvelope(body({ ...smsCreate }));

    expect(verification).toEqual({
      id: '01997b8e-7f52-7c1a-9d3e-2a4f6b8c0d11',
      destination: '37112345678',
      deliveryMethod: 'sms',
      fee: '0.0345',
      status: 'pending',
      errorCode: null,
      errorDetail: null,
      expiresAt: new Date('2026-08-25T12:00:00.000Z'),
      sms: {
        template: 'Your verification code is {code}',
        language: 'de-DE',
        interceptionTimeoutSeconds: 120,
        appHash: 'FA+9qCX9VSu',
      },
      callout: null,
    });
  });

  it('decodes a callout create, callout block included', () => {
    const verification = decodeVerificationEnvelope(body({ ...calloutCreate }));

    expect(verification.callout).toEqual({ language: 'pt-PT' });
    expect(verification.sms).toBeNull();
  });

  it('decodes a callout block carrying no language to null, the value a legacy row answers with', () => {
    const verification = decodeVerificationEnvelope(body({ ...calloutCreate, callout: {} }));

    expect(verification.callout).toEqual({ language: null });
  });

  it('decodes an sms block carrying no language to null', () => {
    const verification = decodeVerificationEnvelope(
      body({ ...smsCreate, sms: { template: 'Your code is {code}', interception_timeout: 120 } }),
    );

    expect(verification.sms?.language).toBeNull();
  });

  it('decodes a callout block on a channel other than callout, keying off the block', () => {
    const verification = decodeVerificationEnvelope(
      body({ ...calloutCreate, delivery_method: 'sms' }),
    );

    expect(verification.callout?.language).toBe('pt-PT');
  });

  it('decodes a create carrying no callout key at all to `callout: null`', () => {
    const raw = body({ ...smsCreate });
    expect(raw).not.toContain('callout');

    expect(decodeVerificationEnvelope(raw).callout).toBeNull();
  });

  it('decodes an explicit `callout: null` to null', () => {
    expect(
      decodeVerificationEnvelope(body({ ...calloutCreate, callout: null })).callout,
    ).toBeNull();
  });

  it('decodes a create carrying no sms key at all to `sms: null`', () => {
    const raw = body({ ...noSmsBlockCreate });
    expect(raw).not.toContain('sms');

    expect(decodeVerificationEnvelope(raw).sms).toBeNull();
  });

  it('decodes an explicit `sms: null` to null', () => {
    const verification = decodeVerificationEnvelope(body({ ...noSmsBlockCreate, sms: null }));

    expect(verification.sms).toBeNull();
  });

  it('decodes an sms block on a channel other than sms, keying off the block, not the channel', () => {
    const verification = decodeVerificationEnvelope(
      body({ ...smsCreate, delivery_method: 'callout' }),
    );

    expect(verification.deliveryMethod).toBe('callout');
    expect(verification.sms?.interceptionTimeoutSeconds).toBe(120);
  });

  it('decodes a 201 that is already denied — a create response is not necessarily pending', () => {
    const verification = decodeVerificationEnvelope(
      body({
        ...smsCreate,
        status: 'denied',
        error_code: 'denied_by_callback',
        error_detail: 'The application denied the verification.',
      }),
    );

    expect(verification.status).toBe('denied');
    expect(verification.errorCode).toBe('denied_by_callback');
    expect(verification.errorDetail).toBe('The application denied the verification.');
  });

  it('decodes an unknown status as the string received', () => {
    const verification = decodeVerificationEnvelope(body({ ...smsCreate, status: 'quarantined' }));

    expect(verification.status).toBe('quarantined');
  });

  it('decodes an unknown delivery_method as the string received', () => {
    const verification = decodeVerificationEnvelope(
      body({ ...smsCreate, delivery_method: 'whatsapp' }),
    );

    expect(verification.deliveryMethod).toBe('whatsapp');
  });

  it('decodes an unknown error_code as the string received', () => {
    const verification = decodeVerificationEnvelope(
      body({ ...smsCreate, status: 'failed', error_code: 'carrier_rejected' }),
    );

    expect(verification.errorCode).toBe('carrier_rejected');
  });

  it('keeps `fee` a string, digit for digit', () => {
    const verification = decodeVerificationEnvelope(body({ ...smsCreate, fee: '0.0345' }));

    expect(verification.fee).toBe('0.0345');
    expect(typeof verification.fee).toBe('string');
  });

  it('decodes a null `fee` to null', () => {
    expect(decodeVerificationEnvelope(body({ ...smsCreate, fee: null })).fee).toBeNull();
  });

  it('decodes a present `expires_at` to a Date', () => {
    const verification = decodeVerificationEnvelope(
      body({ ...smsCreate, expires_at: '2026-08-25T12:00:00.000Z' }),
    );

    expect(verification.expiresAt).toEqual(new Date('2026-08-25T12:00:00.000Z'));
  });

  it('decodes a null `expires_at` to null rather than throwing', () => {
    expect(
      decodeVerificationEnvelope(body({ ...smsCreate, expires_at: null })).expiresAt,
    ).toBeNull();
  });

  it('decodes an `expires_at` carrying a numeric zone offset', () => {
    const verification = decodeVerificationEnvelope(
      body({ ...smsCreate, expires_at: '2026-08-25T14:30:00+03:00' }),
    );

    expect(verification.expiresAt).toEqual(new Date('2026-08-25T11:30:00.000Z'));
  });

  // `new Date` reads every one of these as a confident, wrong instant except the last two.
  it.each([
    ['not-a-date'],
    ['2026'],
    ['120'],
    ['25 Aug 2026'],
    ['2026-08-25'],
    ['2026-08-25 12:00:00Z'],
    ['2026-08-25T12:00:00'],
    ['2026-02-30T00:00:00Z'],
    ['2027-02-29T00:00:00Z'],
    ['2026-13-01T00:00:00Z'],
    ['1798761600'],
  ])('rejects `expires_at` of %s rather than producing a wrong Date', (value) => {
    const raw = body({ ...smsCreate, expires_at: value });

    const error = decodingErrorFrom(() => decodeVerificationEnvelope(raw));
    expect(error.message).toMatch(/expires_at/);
    expect(error.body).toBe(raw);
  });

  it('decodes an absent app_hash to null', () => {
    const raw = body({
      ...smsCreate,
      sms: { template: 'Code: {code}', interception_timeout: 120 },
    });
    expect(raw).not.toContain('app_hash');

    expect(decodeVerificationEnvelope(raw).sms?.appHash).toBeNull();
  });

  it('decodes a present app_hash to the string', () => {
    expect(decodeVerificationEnvelope(body({ ...smsCreate })).sms?.appHash).toBe('FA+9qCX9VSu');
  });

  it('decodes a null template and a missing interception_timeout defensively', () => {
    const verification = decodeVerificationEnvelope(
      body({ ...smsCreate, sms: { template: null } }),
    );

    expect(verification.sms).toEqual({
      template: null,
      language: null,
      interceptionTimeoutSeconds: null,
      appHash: null,
    });
  });

  it('omits `unsafeRawPayload` entirely by default', () => {
    const verification = decodeVerificationEnvelope(body({ ...smsCreate }));

    expect('unsafeRawPayload' in verification).toBe(false);
  });

  it('omits `unsafeRawPayload` when keepRawPayload is false', () => {
    const verification = decodeVerificationEnvelope(body({ ...smsCreate }), {
      keepRawPayload: false,
    });

    expect('unsafeRawPayload' in verification).toBe(false);
  });

  it('carries the raw `data` object when keepRawPayload is on', () => {
    const verification = decodeVerificationEnvelope(body({ ...smsCreate }), {
      keepRawPayload: true,
    });

    expect('unsafeRawPayload' in verification).toBe(true);
    expect(verification.unsafeRawPayload).toEqual(smsCreate);
  });

  it.each([
    ['a body that is not JSON', '<html>502 Bad Gateway</html>'],
    ['a JSON body that is not an object', '"pending"'],
    ['a JSON array', '[]'],
    ['an envelope with no data object', '{"errors":[]}'],
    ['a data key that is an array', '{"data":[]}'],
  ])('rejects %s', (_label, raw) => {
    const error = decodingErrorFrom(() => decodeVerificationEnvelope(raw));
    expect(error.body).toBe(raw);
  });

  it.each([
    ['id', { ...smsCreate, id: undefined }],
    ['destination', { ...smsCreate, destination: undefined }],
    ['delivery_method', { ...smsCreate, delivery_method: undefined }],
    ['status', { ...smsCreate, status: undefined }],
  ])('rejects a missing `%s` as malformed', (key, data) => {
    const error = decodingErrorFrom(() => decodeVerificationEnvelope(body(data)));
    expect(error.message).toContain(key);
  });

  it.each([
    ['fee', { ...smsCreate, fee: 0.0345 }],
    ['error_detail', { ...smsCreate, error_detail: 42 }],
    ['expires_at', { ...smsCreate, expires_at: 1_756_123_200 }],
  ])('rejects a `%s` of the wrong JSON type', (key, data) => {
    const error = decodingErrorFrom(() => decodeVerificationEnvelope(body(data)));
    expect(error.message).toContain(key);
  });

  it('rejects an sms block that is not an object', () => {
    const error = decodingErrorFrom(() =>
      decodeVerificationEnvelope(body({ ...smsCreate, sms: 'yes' })),
    );
    expect(error.message).toMatch(/sms/);
  });

  it('rejects a callout block that is not an object', () => {
    const error = decodingErrorFrom(() =>
      decodeVerificationEnvelope(body({ ...calloutCreate, callout: 'pt-PT' })),
    );
    expect(error.message).toMatch(/callout/);
  });

  it('rejects a non-string callout language', () => {
    const error = decodingErrorFrom(() =>
      decodeVerificationEnvelope(body({ ...calloutCreate, callout: { language: 351 } })),
    );
    expect(error.message).toMatch(/language/);
  });

  it('rejects a non-numeric interception_timeout', () => {
    const error = decodingErrorFrom(() =>
      decodeVerificationEnvelope(body({ ...smsCreate, sms: { interception_timeout: '120' } })),
    );
    expect(error.message).toContain('interception_timeout');
  });
});

describe('decodeErrorEnvelope', () => {
  it('decodes a single item', () => {
    const items = [{ code: 'unauthorized', detail: 'Authentication failed.' }];

    expect(decodeErrorEnvelope(JSON.stringify({ errors: items }))).toEqual([
      { code: 'unauthorized', detail: 'Authentication failed.' },
    ]);
  });

  it('decodes several items and preserves wire order', () => {
    const items = [
      { code: 'destination_blank', detail: "Destination can't be blank." },
      { code: 'delivery_method_blank', detail: "Delivery method can't be blank." },
      { code: 'app_hash_invalid', detail: 'App hash is invalid.' },
    ];

    expect(decodeErrorEnvelope(JSON.stringify({ errors: items })).map((item) => item.code)).toEqual(
      ['destination_blank', 'delivery_method_blank', 'app_hash_invalid'],
    );
  });

  it('decodes an unknown code as the string received', () => {
    const raw = JSON.stringify({ errors: [{ code: 'plan_suspended', detail: 'Suspended.' }] });

    expect(decodeErrorEnvelope(raw)[0]?.code).toBe('plan_suspended');
  });

  it('decodes a missing detail to null', () => {
    expect(decodeErrorEnvelope('{"errors":[{"code":"internal_error"}]}')).toEqual([
      { code: 'internal_error', detail: null },
    ]);
  });

  it('decodes an empty array rather than assuming the array is non-empty', () => {
    expect(decodeErrorEnvelope('{"errors":[]}')).toEqual([]);
  });

  it('rejects a non-JSON body and carries the raw body', () => {
    const raw = '<html><head><title>502 Bad Gateway</title></head></html>';

    const error = decodingErrorFrom(() => decodeErrorEnvelope(raw));
    expect(error.body).toBe(raw);
    expect(error.message).toMatch(/not JSON/);
  });

  it.each([
    ['a JSON body that is not an object', 'null'],
    ['an envelope with no errors array', '{"data":{}}'],
    ['an errors key that is not an array', '{"errors":{"code":"not_found"}}'],
    ['an entry that is not an object', '{"errors":["not_found"]}'],
    ['an entry with no code', '{"errors":[{"detail":"Nope."}]}'],
  ])('rejects %s', (_label, raw) => {
    const error = decodingErrorFrom(() => decodeErrorEnvelope(raw));
    expect(error.body).toBe(raw);
  });
});
