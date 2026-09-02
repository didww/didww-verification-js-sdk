import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { constantTimeEquals } from './compare.js';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const SIGNATURE = createHmac('sha256', 'secret').update('payload').digest('base64');

// The last significant base64 character of a 32-byte digest carries only 4 meaningful bits; the
// three other characters of its group decode to the same bytes.
function decodeAlias(signature: string): string {
  const index = signature.indexOf('=');
  const last = signature[index - 1] as string;
  const value = ALPHABET.indexOf(last);
  const alias = ALPHABET[(value & 0b111100) | ((value + 1) & 0b11)] as string;
  return signature.slice(0, index - 1) + alias + signature.slice(index);
}

describe('constantTimeEquals', () => {
  it('holds the 44-character invariant the length guard relies on', () => {
    expect(SIGNATURE).toHaveLength(44);
  });

  it('accepts identical signatures', () => {
    expect(constantTimeEquals(SIGNATURE, SIGNATURE)).toBe(true);
    expect(constantTimeEquals(SIGNATURE, `${SIGNATURE}`)).toBe(true);
  });

  it('rejects same-length signatures that differ', () => {
    const other = createHmac('sha256', 'secret').update('payload!').digest('base64');
    expect(other).toHaveLength(SIGNATURE.length);
    expect(constantTimeEquals(SIGNATURE, other)).toBe(false);
  });

  it('rejects differing lengths without throwing, where timingSafeEqual would throw', () => {
    expect(() =>
      timingSafeEqual(Buffer.from(SIGNATURE, 'utf8'), Buffer.from(SIGNATURE.slice(0, 43), 'utf8')),
    ).toThrow();
    expect(constantTimeEquals(SIGNATURE, SIGNATURE.slice(0, 43))).toBe(false);
    expect(constantTimeEquals(SIGNATURE, `${SIGNATURE}x`)).toBe(false);
    expect(constantTimeEquals('', SIGNATURE)).toBe(false);
  });

  it('measures bytes, not characters', () => {
    // 'é' is one character and two UTF-8 bytes.
    expect(constantTimeEquals('é', 'a')).toBe(false);
    expect(constantTimeEquals('é', 'ab')).toBe(false);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('rejects a %s operand on either side', (_label, absent) => {
    expect(constantTimeEquals(absent, SIGNATURE)).toBe(false);
    expect(constantTimeEquals(SIGNATURE, absent)).toBe(false);
    expect(constantTimeEquals(absent, absent)).toBe(false);
  });

  it('compares two empty strings as equal', () => {
    // Callers must reject a missing signature before comparing; '' is not special here.
    expect(constantTimeEquals('', '')).toBe(true);
  });

  it.each([
    ['unused final bits', 'Zg==', 'Zh=='],
    ['omitted padding', 'Zg==', 'Zg'],
    ['a realistic signature', SIGNATURE, decodeAlias(SIGNATURE)],
  ])('rejects strings that decode identically: %s', (_label, left, right) => {
    expect(left).not.toBe(right);
    expect(Buffer.from(left, 'base64').equals(Buffer.from(right, 'base64'))).toBe(true);
    expect(constantTimeEquals(left, right)).toBe(false);
  });
});
