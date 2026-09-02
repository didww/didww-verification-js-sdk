import { Buffer } from 'node:buffer';
import { ConfigurationError } from '@didww/verification-core';
import { describe, expect, it } from 'vitest';
import { decodeSecret } from './secret.js';

const SECRET = 'Vs_4BEq2n7ZBe5nZIUPDAo_9RZfhl8kSBZgkCMMmvNU';

// The pair the round-trip exists for: both decode to the same 26 bytes, the server accepts only
// the first, and Node's decoder rewrites the second into the first without complaint.
const CANONICAL = 'tEsT_secret_urlsafe_base64_value_AA';
const NON_CANONICAL = 'tEsT_secret_urlsafe_base64_value_AB';

describe('decodeSecret', () => {
  it('decodes a minted secret to its raw bytes', () => {
    const bytes = decodeSecret(SECRET);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(32);
    expect([...bytes.slice(0, 4)]).toEqual([86, 207, 248, 4]);
    expect([...bytes.slice(-2)]).toEqual([188, 213]);
  });

  it.each([
    ['on the 26-byte vector', NON_CANONICAL],
    ['on the minted 32-byte one', 'Vs_4BEq2n7ZBe5nZIUPDAo_9RZfhl8kSBZgkCMMmvNV'],
  ])('rejects a non-canonical encoding %s', (_label, value) => {
    expect(() => decodeSecret(value)).toThrow(ConfigurationError);
    expect(() => decodeSecret(value)).toThrow(/canonical/i);
  });

  it('accepts a hand-padded secret, which the server accepts too', () => {
    expect(decodeSecret(`${CANONICAL}=`)).toHaveLength(26);
    expect(decodeSecret(`${CANONICAL}=`)).toEqual(decodeSecret(CANONICAL));
  });

  it('normalises the rejected encoding into the accepted one, which is why the check exists', () => {
    expect(Buffer.from(NON_CANONICAL, 'base64url').toString('base64url')).toBe(CANONICAL);
  });

  it.each([
    ['a "/" from the standard alphabet', 'Vs/4BEq2n7ZBe5nZIUPDAo/9RZfhl8kSBZgkCMMmvNU'],
    ['a "+" from the standard alphabet', 'Vs+4BEq2n7ZBe5nZIUPDAo+9RZfhl8kSBZgkCMMmvNU'],
    ['a character outside base64', 'Vs_4BEq2n7ZBe5nZIUPDAo_9RZfhl8kSBZgkCMMmv!U'],
    ['whitespace inside', 'Vs_4BEq2n7ZBe5nZIUPDAo_9RZfhl8kSBZgkC MMmvNU'],
    ['both, padded -- a value the server itself accepts', 'tEsT+secret/urlsafe_base64_value_AA='],
  ])('rejects %s', (_label, value) => {
    expect(() => decodeSecret(value)).toThrow(ConfigurationError);
    // Not /URL-safe/: the canonicality message contains that too, so the assertion would pass
    // with this branch disabled.
    expect(() => decodeSecret(value)).toThrow(/expected only A-Z, a-z, 0-9/);
  });

  it.each([
    ['an empty string', ''],
    ['spaces', '   '],
    ['a tab and a newline', '\t\n'],
    ['undefined from plain JavaScript', undefined as unknown as string],
  ])('rejects %s', (_label, value) => {
    expect(() => decodeSecret(value)).toThrow(ConfigurationError);
    expect(() => decodeSecret(value)).toThrow(/missing or blank/);
  });

  it.each([
    ['mid-string', 'tEsT_secret=urlsafe_base64_value_AA'],
    ['one character from the end', 'tEsT_secret_urlsafe_base64_value_A=A'],
  ])('rejects "=" %s, outside the trailing run', (_label, value) => {
    expect(() => decodeSecret(value)).toThrow(ConfigurationError);
    expect(() => decodeSecret(value)).toThrow(/outside its trailing padding/);
  });

  it.each([
    ['one character over a group boundary', 'tEsT_secret_urlsafe_base64_value_'],
    ['over-padded', `${CANONICAL}==`],
    ['under-padded', 'tEsT_secret_urlsafe_base64_value_A='],
    ['padding on a whole group', 'AAAA='],
    ['padding only', '='],
  ])('rejects %s', (_label, value) => {
    expect(() => decodeSecret(value)).toThrow(ConfigurationError);
    expect(() => decodeSecret(value)).toThrow(/valid base64 length/);
  });

  it.each([
    ['non-canonical', NON_CANONICAL],
    ['standard alphabet', 'Vs+4BEq2n7ZBe5nZIUPDAo+9RZfhl8kSBZgkCMMmvNU'],
    ['bad length', 'tEsT_secret_urlsafe_base64_value_'],
    ['embedded "="', 'tEsT_secret=urlsafe_base64_value_AA'],
  ])('does not echo the secret when rejecting a %s one', (_label, value) => {
    expect(() => decodeSecret(value)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining(value) }),
    );
  });

  it('returns bytes that do not share a pooled ArrayBuffer', () => {
    const bytes = decodeSecret(SECRET);

    expect(bytes.byteOffset).toBe(0);
    expect(bytes.buffer.byteLength).toBe(bytes.length);
  });
});
