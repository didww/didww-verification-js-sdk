import { ConfigurationError, type AuthProvider, type AuthRequest } from '@didww/verification-core';

import { Signer } from './signer.js';

/**
 * Signed `application` auth: `Authorization: Application <key>:<signature>` plus `x-timestamp`,
 * and nothing else — the content type is signed, so only the client may set it.
 *
 * @throws ConfigurationError when the key is blank or contains `":"`, or the secret is not
 * canonical URL-safe base64 — at construction, not on the first request.
 */
export function applicationAuth(options: {
  key: string;
  secret: string;
  /** Epoch milliseconds. Defaults to `Date.now`. */
  clock?: () => number;
}): AuthProvider {
  const { key } = options;
  if (key.trim() === '') {
    throw new ConfigurationError('applicationAuth key must not be blank.');
  }
  if (key.includes(':')) {
    // The server reads 'Application <key>:<rest>' and splits on the first colon, so the tail of
    // the key would be taken as the signature.
    throw new ConfigurationError(
      'applicationAuth key must not contain ":": the server splits "Application <key>:<signature>" ' +
        'on the first colon, so the rest of the key would be read as the signature.',
    );
  }

  const signer = new Signer(options.secret);
  const clock = options.clock ?? Date.now;

  return {
    headers(request: AuthRequest): Record<string, string> {
      // One reading of the clock: the value sent is the value signed. Deriving it twice races
      // across a second boundary and 401s with a valid signature on both sides.
      const timestamp = String(Math.floor(clock() / 1000));
      const signature = signer.sign({ ...request, timestamp });

      return { Authorization: `Application ${key}:${signature}`, 'x-timestamp': timestamp };
    },
  };
}
