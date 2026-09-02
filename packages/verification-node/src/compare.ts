import { Buffer } from 'node:buffer';
import { timingSafeEqual } from 'node:crypto';

/** Constant-time equality over two base64 signature strings. */
export function constantTimeEquals(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return false;

  // The raw base64 ASCII, never `Buffer.from(value, 'base64')`: the decoder ignores padding,
  // whitespace and the unused low bits of the final character, so distinct garbage strings decode
  // to identical bytes and a decoding comparison accepts signatures it must reject.
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');

  // `timingSafeEqual` throws on unequal lengths, so the guard comes first. It leaks nothing: a
  // valid HMAC-SHA256 in base64 is always 44 characters.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
