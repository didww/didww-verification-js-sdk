import { describe, expect, it } from 'vitest';
import { redact } from './redact.js';

describe('redact', () => {
  it('masks a digit run of six', () => {
    expect(redact('code 123456')).toBe('code [redacted]');
  });

  it('masks a destination inside a URL path', () => {
    expect(
      redact('GET https://verification.didww.com/api/v1/verifications/by_number/491511234'),
    ).toBe('GET https://verification.didww.com/api/v1/verifications/by_number/[redacted]');
  });

  it('masks every run, not just the first', () => {
    expect(redact('491511234 and 4915199999')).toBe('[redacted] and [redacted]');
  });

  it('leaves runs of five or fewer alone, so a status and a port stay readable', () => {
    expect(redact('GET https://verification.didww.com:8443/api/v1/verifications -> 200')).toBe(
      'GET https://verification.didww.com:8443/api/v1/verifications -> 200',
    );
    expect(redact('12345')).toBe('12345');
  });

  it('masks the digits of a run that is embedded in other characters', () => {
    expect(redact('id=abc1234567def')).toBe('id=abc[redacted]def');
  });
});
