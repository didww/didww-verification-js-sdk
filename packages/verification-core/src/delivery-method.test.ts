import { describe, expect, it } from 'vitest';
import { DELIVERY_METHODS, expectsCode, isKnownDeliveryMethod } from './delivery-method.js';

describe('isKnownDeliveryMethod', () => {
  it.each([...DELIVERY_METHODS])('is true for %s', (method) => {
    expect(isKnownDeliveryMethod(method)).toBe(true);
  });

  it.each(['carrier_pigeon', '', 'SMS', 'constructor'])('is false for %j', (value) => {
    expect(isKnownDeliveryMethod(value)).toBe(false);
  });
});

describe('expectsCode', () => {
  it.each([
    ['sms', true],
    ['callout', true],
  ] as const)('is %s -> %s', (method, expected) => {
    expect(expectsCode(method)).toBe(expected);
  });

  it.each(['whatsapp', '', 'SMS'])('is undefined for the unmodelled channel %j', (method) => {
    expect(expectsCode(method)).toBeUndefined();
  });
});
