import { createHash, createHmac } from 'node:crypto';
import { decodeSecret } from './secret.js';

export interface SignInput {
  readonly method: string;
  readonly path: string;
  readonly contentType: string;
  readonly body: string;
  readonly timestamp: string | number;
}

/** Signs requests with an application key pair, over the API's five-line canonical string. */
export class Signer {
  readonly #key: Uint8Array;

  /** @throws ConfigurationError when `secret` is not canonical URL-safe base64. */
  constructor(secret: string) {
    this.#key = decodeSecret(secret);
  }

  /**
   * The five canonical lines joined by "\n" — public so a human can diff it against the server
   * when a production signature mismatches.
   */
  stringToSign(input: SignInput): string {
    return [
      input.method.toUpperCase(),
      contentMd5(input.body),
      input.contentType,
      `x-timestamp:${input.timestamp}`,
      input.path,
    ].join('\n');
  }

  sign(input: SignInput): string {
    return createHmac('sha256', this.#key)
      .update(this.stringToSign(input), 'utf8')
      .digest('base64');
  }
}

// Emptiness is `length === 0`, not a trim: the server derives this line from a presence check, so
// a whitespace-only body signs as '' there and as an MD5 here. A real divergence, but unreachable
// -- the SDK never sends such a body.
function contentMd5(body: string): string {
  if (body.length === 0) return '';

  return createHash('md5').update(body, 'utf8').digest('base64');
}
