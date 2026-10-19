import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
  VERIFICATION_ERROR_CODES,
  isKnownApiErrorCode,
  type KnownApiErrorCode,
  type VerificationStatus,
} from './error-codes.js';

// Conditional-type identity: `A extends B` is true for two different open unions, so only this
// discriminates. `Equals<X, string>` resolving to `false` is what proves the helper is not vacuous.
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

describe('VerificationStatus', () => {
  it('is exactly the five known members plus the open arm', () => {
    // The annotation is the assertion: `Equals` yields `false` and this fails to compile if the
    // union drifts, which is what keeps editor completion listing the five.
    const exact: Equals<
      VerificationStatus,
      'pending' | 'verified' | 'failed' | 'expired' | 'denied' | (string & {})
    > = true;
    expect(exact).toBe(true);
  });

  it('has not collapsed to plain string', () => {
    const collapsed: Equals<VerificationStatus, string> = false;
    expect(collapsed).toBe(false);
  });

  it('accepts a status this release does not model', () => {
    const decoded: VerificationStatus = 'quantum_pending';
    expect(decoded).toBe('quantum_pending');
  });
});

describe('ApiErrorCode', () => {
  it('kept its literal members through the spread rather than widening to string', () => {
    // A spread that degraded to `string[]` would leave `isKnownApiErrorCode` narrowing to
    // `string`, i.e. guarding nothing, while every runtime test still passed.
    const widened: Equals<KnownApiErrorCode, string> = false;
    expect(widened).toBe(false);
  });
});

describe('isKnownApiErrorCode', () => {
  it.each([...API_ERROR_CODES])('is true for %s', (code) => {
    expect(isKnownApiErrorCode(code)).toBe(true);
  });

  it.each(['carrier_pigeon', '', 'Unauthorized', 'toString'])('is false for %j', (value) => {
    expect(isKnownApiErrorCode(value)).toBe(false);
  });
});

describe('API_ERROR_CODES', () => {
  it.each([
    'custom_too_long',
    'autofill_invalid',
    'sms_domain_not_configured',
    'template_group_not_found',
    'rate_limit_per_ip',
    'rate_limit_failed_auth',
    'rate_limit_per_account',
    'rate_limit_public_per_account',
    'volume_limit_reached',
  ])('lists %s', (code) => {
    expect(isKnownApiErrorCode(code)).toBe(true);
  });

  it('lists autofill_invalid right before app_hash_invalid', () => {
    const at = API_ERROR_CODES.indexOf('app_hash_invalid');

    expect(API_ERROR_CODES[at - 1]).toBe('autofill_invalid');
  });
});

describe('VERIFICATION_ERROR_CODES', () => {
  it.each([
    'application_paused',
    'destination_country_disabled',
    'destination_not_supported_for_channel',
  ])('lists the outcome %s', (code) => {
    expect(VERIFICATION_ERROR_CODES).toContain(code);
  });

  it('keeps the deprecated stale_dispatch', () => {
    expect(VERIFICATION_ERROR_CODES).toContain('stale_dispatch');
  });
});
