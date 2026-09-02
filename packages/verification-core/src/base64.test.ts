import { describe, expect, it } from 'vitest';
import { base64Encode } from './base64.js';

describe('base64Encode', () => {
  it.each([
    ['', ''],
    ['f', 'Zg=='],
    ['fo', 'Zm8='],
    ['foo', 'Zm9v'],
    ['foob', 'Zm9vYg=='],
    ['fooba', 'Zm9vYmE='],
    ['foobar', 'Zm9vYmFy'],
  ])('encodes %j at every padding length', (input, expected) => {
    expect(base64Encode(input)).toBe(expected);
  });

  it.each([
    ['two-byte', 'é', 'w6k='],
    ['three-byte', '€', '4oKs'],
    ['four-byte astral', '😀', '8J+YgA=='],
    ['mixed widths', 'abcé€😀', 'YWJjw6nigqzwn5iA'],
  ])('encodes %s UTF-8', (_label, input, expected) => {
    expect(base64Encode(input)).toBe(expected);
  });

  it.each([
    ['a lone high surrogate', '\ud83d', '77+9'],
    ['a lone low surrogate', '\ude00', '77+9'],
    ['a high surrogate followed by a non-surrogate', 'a\ud83db', 'Ye+/vWI='],
    ['a reversed pair', '\ude00\ud83d', '77+977+9'],
  ])('replaces %s with U+FFFD', (_label, input, expected) => {
    expect(base64Encode(input)).toBe(expected);
  });

  it('encodes a credential pair', () => {
    expect(base64Encode('key:secret')).toBe('a2V5OnNlY3JldA==');
  });

  it('encodes a credential pair with a non-ASCII secret', () => {
    expect(base64Encode('ak_live_9f3c:s3cr3t-pässwörd/+=')).toBe(
      'YWtfbGl2ZV85ZjNjOnMzY3IzdC1ww6Rzc3fDtnJkLys9',
    );
  });

  it('emits both non-alphanumeric alphabet characters', () => {
    expect(base64Encode('ÿï¾')).toBe('w7/Dr8K+');
  });

  it('pads to a multiple of four', () => {
    for (let length = 0; length < 32; length += 1) {
      expect(base64Encode('a'.repeat(length)).length % 4).toBe(0);
    }
  });
});
