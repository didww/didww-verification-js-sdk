import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

describe('redact', () => {
  it('masks a digit run of six', () => {
    expect(redact('code 123456')).toBe('code [redacted]');
  });

  it.each([4, 5, 6, 7, 8])('masks a code of every server-chosen length (%i)', (length) => {
    expect(redact(`code ${'7'.repeat(length)}`)).toBe('code [redacted]');
  });

  it('leaves a UUID intact', () => {
    const id = '0198f3c2-7a41-71ce-8f21-419283746501';
    expect(redact(`GET https://verification.didww.com/api/v1/verifications/${id} -> 200`)).toBe(
      `GET https://verification.didww.com/api/v1/verifications/${id} -> 200`,
    );
  });

  it('still masks a code and a destination alongside a UUID', () => {
    const id = '0198f3c2-7a41-71ce-8f21-419283746501';
    expect(redact(`id ${id} code 1234 long 12345678 to 491511234567`)).toBe(
      `id ${id} code [redacted] long [redacted] to [redacted]`,
    );
  });

  it('still masks a code adjacent to a UUID', () => {
    const id = '0198f3c2-7a41-71ce-8f21-419283746501';
    expect(redact(`${id}/1234`)).toBe(`${id}/[redacted]`);
  });

  it('does not treat a bare hex blob as a UUID, because hyphens are required', () => {
    expect(redact('blob 0198f3c27a4171ce8f21419283746501')).toBe(
      'blob [redacted]f3c27a[redacted]ce8f[redacted]',
    );
  });

  it('masks a destination inside a URL path', () => {
    expect(
      redact('GET https://verification.didww.com/api/v1/verifications/by_number/491511234'),
    ).toBe('GET https://verification.didww.com/api/v1/verifications/by_number/[redacted]');
  });

  it('masks every run, not just the first', () => {
    expect(redact('491511234 and 4915199999')).toBe('[redacted] and [redacted]');
  });

  it('leaves runs of three or fewer alone, so a status stays readable', () => {
    expect(redact('GET /api/v1/verifications -> 200')).toBe('GET /api/v1/verifications -> 200');
    expect(redact('123')).toBe('123');
  });

  it('masks a four-digit port along with the codes — the accepted cost of the wider run', () => {
    expect(redact('GET https://verification.didww.com:8443/api/v1/verifications')).toBe(
      'GET https://verification.didww.com:[redacted]/api/v1/verifications',
    );
  });

  it('masks the digits of a run that is embedded in other characters', () => {
    expect(redact('id=abc1234567def')).toBe('id=abc[redacted]def');
  });
});
