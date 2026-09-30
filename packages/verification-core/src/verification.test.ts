import { describe, expect, it } from 'vitest';
import { isFinished, isPending, type SmsAutofill, type Verification } from './verification.js';

function verification(overrides: Partial<Verification> = {}): Verification {
  return {
    id: '018f3f8e-0000-7000-8000-000000000000',
    destination: '37112345678',
    deliveryMethod: 'sms',
    fee: '0.0345',
    status: 'pending',
    errorCode: null,
    errorDetail: null,
    expiresAt: new Date('2026-08-25T10:02:00.000Z'),
    sms: {
      template: 'Your code is {code}',
      language: 'en-US',
      interceptionTimeoutSeconds: 120,
      autofill: null,
      appHash: null,
      codeLength: 6,
    },
    callout: null,
    ...overrides,
  };
}

describe('isPending / isFinished', () => {
  it('reads pending as pending', () => {
    const v = verification();
    expect(isPending(v)).toBe(true);
    expect(isFinished(v)).toBe(false);
  });

  it.each(['verified', 'failed', 'expired', 'denied'])('reads %s as finished', (status) => {
    const v = verification({ status });
    expect(isPending(v)).toBe(false);
    expect(isFinished(v)).toBe(true);
  });

  it('reads a status this release does not model as finished, so a poll terminates', () => {
    const v = verification({ status: 'quantum_pending' });
    expect(isFinished(v)).toBe(true);
  });

  it('carries a nullable expiresAt and a decimal-string fee', () => {
    const v = verification({ expiresAt: null, fee: null, sms: null, deliveryMethod: 'callout' });
    expect(v.expiresAt).toBeNull();
    expect(v.fee).toBeNull();
  });
});

describe('SmsAutofill', () => {
  it('keeps its type union closed, so a check on type narrows', () => {
    const autofill: SmsAutofill = { type: 'app_hash', value: 'FA+9qCX9VSu' };
    // @ts-expect-error A marker type this release does not model is not assignable.
    const unmodelled: SmsAutofill = { type: 'domain', value: 'FA+9qCX9VSu' };

    expect(autofill.type).toBe('app_hash');
    expect(unmodelled.type).toBe('domain');
  });
});
