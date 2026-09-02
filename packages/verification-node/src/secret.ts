import { Buffer } from 'node:buffer';
import { ConfigurationError } from '@didww/verification-core';

// The round-trip below already rejects `+` and `/`, because it re-encodes into the URL-safe
// alphabet -- rejecting them at all is a deliberate choice, since the server accepts both. So this
// branch decides nothing; it exists so the likeliest paste error gets a message naming its cause.
const URL_SAFE_BASE64 = /^[A-Za-z0-9_-]*$/;

/** Decodes an application secret from canonical URL-safe base64 into its raw signing key. */
export function decodeSecret(secret: string): Uint8Array {
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new ConfigurationError('Application secret is missing or blank.');
  }

  const body = secret.replace(/=+$/, '');
  const padding = secret.length - body.length;

  if (body.includes('=')) {
    throw new ConfigurationError('Application secret contains "=" outside its trailing padding.');
  }

  if (!URL_SAFE_BASE64.test(body)) {
    throw new ConfigurationError(
      'Application secret is not URL-safe base64: expected only A-Z, a-z, 0-9, "-" and "_".',
    );
  }

  const canonicalPadding = (4 - (body.length % 4)) % 4;
  if (body.length % 4 === 1 || (padding > 0 && padding !== canonicalPadding)) {
    throw new ConfigurationError('Application secret is not a valid base64 length.');
  }

  const bytes = Buffer.from(body, 'base64url');
  // Node's decoder silently normalises a non-canonical tail -- one whose final character carries
  // non-zero unused bits -- so `…_AB` becomes `…_AA` and every later signature uses a key the
  // server never issued. The server rejects that encoding outright; re-encoding is how we see it.
  if (bytes.toString('base64url') !== body) {
    throw new ConfigurationError('Application secret is not canonical URL-safe base64.');
  }

  // Copied off Buffer's shared allocation pool so the key does not sit in memory beside unrelated
  // bytes reachable through the same ArrayBuffer.
  return new Uint8Array(bytes);
}
