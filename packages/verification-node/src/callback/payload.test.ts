import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_BODY_BYTES, bodyByteLength, parseCallbackPayload } from './payload.js';

const KEY = '3f2a1c60-8b7e-4d21-9c55-0e6b1a7d4f88';

// The envelope the API sends: a `data` block in wire snake_case under a named event.
const BODY = JSON.stringify({
  event: 'verification_request',
  data: {
    id: '01920a7b-0000-7000-8000-000000000001',
    destination: '12025550143',
    delivery_method: 'sms',
  },
});

describe('bodyByteLength', () => {
  it('counts bytes, not characters', () => {
    // A character count would read this as 3 and let a 3x-oversized body past the cap.
    expect(bodyByteLength('€€€')).toBe(9);
    expect(bodyByteLength('abc')).toBe(3);
  });

  it('agrees with the length of the encoded buffer', () => {
    const mixed = '{"destination":"+370 6…","emoji":"🙂"}';

    expect(bodyByteLength(mixed)).toBe(Buffer.from(mixed, 'utf8').length);
  });

  it('defaults the cap to 8 KiB', () => {
    expect(DEFAULT_MAX_BODY_BYTES).toBe(8192);
  });
});

describe('parseCallbackPayload', () => {
  it('decodes the envelope and carries the key in from the header', () => {
    expect(parseCallbackPayload(BODY, KEY)).toEqual({
      event: 'verification_request',
      key: KEY,
      data: {
        id: '01920a7b-0000-7000-8000-000000000001',
        destination: '12025550143',
        deliveryMethod: 'sms',
      },
    });
  });

  it('passes an event and a channel this release does not model straight through', () => {
    // Unknown is not malformed: a callback for a channel added after this release must still be
    // answerable, or every one of them is denied.
    const body = JSON.stringify({
      event: 'verification_review',
      data: { id: 'id', destination: '12025550143', delivery_method: 'whatsapp' },
    });

    expect(parseCallbackPayload(body, KEY)).toEqual({
      event: 'verification_review',
      key: KEY,
      data: { id: 'id', destination: '12025550143', deliveryMethod: 'whatsapp' },
    });
  });

  it('ignores fields it does not model', () => {
    const body = JSON.stringify({
      event: 'verification_request',
      extra: true,
      data: { id: 'id', destination: '1', delivery_method: 'sms', fee: '0.0345' },
    });

    expect(parseCallbackPayload(body, KEY)?.data).toEqual({
      id: 'id',
      destination: '1',
      deliveryMethod: 'sms',
    });
  });

  it.each([
    ['a body that is not JSON', 'not json'],
    ['an empty body', ''],
    ['a JSON array', '[]'],
    ['a JSON string', '"verification_request"'],
    ['JSON null', 'null'],
    [
      'a missing event',
      JSON.stringify({ data: { id: 'i', destination: 'd', delivery_method: 's' } }),
    ],
    [
      'a non-string event',
      JSON.stringify({ event: 7, data: { id: 'i', destination: 'd', delivery_method: 's' } }),
    ],
    ['a missing data block', JSON.stringify({ event: 'verification_request' })],
    ['a data block that is an array', JSON.stringify({ event: 'e', data: [] })],
    ['a null data block', JSON.stringify({ event: 'e', data: null })],
    [
      'a missing id',
      JSON.stringify({ event: 'e', data: { destination: 'd', delivery_method: 's' } }),
    ],
    [
      'a missing destination',
      JSON.stringify({ event: 'e', data: { id: 'i', delivery_method: 's' } }),
    ],
    [
      'a missing delivery_method',
      JSON.stringify({ event: 'e', data: { id: 'i', destination: 'd' } }),
    ],
    [
      'a non-string id',
      JSON.stringify({ event: 'e', data: { id: 1, destination: 'd', delivery_method: 's' } }),
    ],
    [
      'a camelCase delivery method',
      JSON.stringify({ event: 'e', data: { id: 'i', destination: 'd', deliveryMethod: 's' } }),
    ],
  ])('rejects %s', (_label, body) => {
    expect(parseCallbackPayload(body, KEY)).toBeNull();
  });
});
