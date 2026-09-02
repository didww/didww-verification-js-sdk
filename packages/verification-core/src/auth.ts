import { base64Encode } from './base64.js';
import { ConfigurationError } from './errors.js';

export interface AuthRequest {
  readonly method: string;
  readonly path: string;
  /** `''` on a bodyless request — and no `Content-Type` header is sent either. */
  readonly contentType: string;
  readonly body: string;
}

export interface AuthProvider {
  headers(request: AuthRequest): Record<string, string> | Promise<Record<string, string>>;
}

// Metro injects `__DEV__`; plain Node never defines it, so it may only be read behind a `typeof`
// guard — a bare `!__DEV__` throws a ReferenceError on every Node consumer.
declare const __DEV__: boolean | undefined;

const BASIC_AUTH_RELEASE_WARNING =
  '[@didww/verification-core] basicAuth sends your API secret with every request. In a shipped ' +
  'app that secret is recoverable from the bundle — use it only from a server you control, and ' +
  'use publicAuth on the device.';

function isReactNativeReleaseBuild(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === false;
}

function requirePresent(value: string, label: string): void {
  if (value.trim() === '') {
    throw new ConfigurationError(`${label} must not be blank.`);
  }
}

/**
 * `Authorization: Basic base64(key:secret)`. Server-to-server only — the secret is recoverable
 * from anything it ships in.
 */
export function basicAuth(key: string, secret: string): AuthProvider {
  requirePresent(key, 'basicAuth key');
  requirePresent(secret, 'basicAuth secret');
  if (key.includes(':')) {
    // The server splits the decoded credential on the first colon.
    throw new ConfigurationError(
      'basicAuth key must not contain ":": the server splits the credential on the first colon, ' +
        'so the rest of the key would be read as the secret.',
    );
  }

  if (isReactNativeReleaseBuild()) {
    console.warn(BASIC_AUTH_RELEASE_WARNING);
  }

  const header = `Basic ${base64Encode(`${key}:${secret}`)}`;
  return {
    headers: () => ({ Authorization: header }),
  };
}

/** `Authorization: Application <key>`, unsigned. The key is an identifier, not a secret. */
export function publicAuth(key: string): AuthProvider {
  requirePresent(key, 'publicAuth key');
  if (key.includes(':')) {
    // The server dispatches on the colon: `Application <key>:<signature>` is the signed scheme.
    throw new ConfigurationError(
      'publicAuth key must not contain ":": the server reads "Application <key>:<rest>" as the ' +
        'signed scheme, so the request would be rejected as a bad signature.',
    );
  }

  const header = `Application ${key}`;
  return {
    headers: () => ({ Authorization: header }),
  };
}
