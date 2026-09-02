import { describe, expect, it } from 'vitest';
import {
  API_ERROR_CODES,
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
