import type { Open } from './error-codes.js';

export const DELIVERY_METHODS = ['sms', 'callout'] as const;

export type KnownDeliveryMethod = (typeof DELIVERY_METHODS)[number];
/** Decoded. A channel added after this release arrives as a new string, never as null. */
export type DeliveryMethod = Open<KnownDeliveryMethod>;

/** True when this release models the channel; narrow with it before routing on the value. */
export function isKnownDeliveryMethod(value: string): value is KnownDeliveryMethod {
  return (DELIVERY_METHODS as readonly string[]).includes(value);
}

/**
 * A guard, not a router: `undefined` means this release does not model the channel, and the report
 * guard throws only when the answer is not `undefined` and the pairing is wrong. A channel added
 * after this release must not be blocked from here.
 */
export function expectsCode(method: DeliveryMethod): boolean | undefined {
  switch (method) {
    case 'sms':
    case 'callout':
      return true;
    default:
      return undefined;
  }
}
