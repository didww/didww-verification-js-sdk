import { Buffer } from 'node:buffer';
import type { DeliveryMethod, Open } from '@didww/verification-core';

/** A verified inbound callback: the API asking whether to start this verification. */
export interface CallbackPayload {
  readonly event: Open<'verification_request'>;
  /** The application key from the Authorization header — which application this is for. */
  readonly key: string;
  readonly data: {
    readonly id: string;
    readonly destination: string;
    readonly deliveryMethod: DeliveryMethod;
  };
}

/** The answer the endpoint returns. */
export type CallbackDecision = { action: 'allow' } | { action: 'deny' };

/**
 * Our own bound on unauthenticated work — nothing is hashed until a body passes it. It mirrors no
 * server-side limit; the server's own cap applies to the answer it reads back, not to what it sends.
 */
export const DEFAULT_MAX_BODY_BYTES = 8192;

/** Bytes, never `body.length`: a multi-byte body has to be measured as it arrived. */
export function bodyByteLength(body: string): number {
  return Buffer.byteLength(body, 'utf8');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringAt(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Parses a callback body whose signature has already verified; `null` when the envelope is
 * malformed. An `event` or `delivery_method` this release does not model is unknown, not malformed,
 * and passes through as received.
 */
export function parseCallbackPayload(body: string, key: string): CallbackPayload | null {
  let root: unknown;
  try {
    root = JSON.parse(body) as unknown;
  } catch {
    return null;
  }

  const envelope = asRecord(root);
  if (envelope === null) return null;

  const event = stringAt(envelope, 'event');
  const data = asRecord(envelope['data']);
  if (event === null || data === null) return null;

  const id = stringAt(data, 'id');
  const destination = stringAt(data, 'destination');
  const deliveryMethod = stringAt(data, 'delivery_method');
  if (id === null || destination === null || deliveryMethod === null) return null;

  return { event, key, data: { id, destination, deliveryMethod } };
}
