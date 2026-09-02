import { constantTimeEquals } from '../compare.js';
import { Signer } from '../signer.js';
import { parseAuthorization, type ParsedAuthorization } from './authorization.js';
import {
  DEFAULT_MAX_BODY_BYTES,
  bodyByteLength,
  parseCallbackPayload,
  type CallbackPayload,
} from './payload.js';

export type CallbackRejectionReason =
  | 'missing_signature'
  | 'missing_timestamp'
  | 'timestamp_out_of_window'
  | 'unknown_key'
  | 'signature_mismatch'
  | 'body_too_large'
  | 'unparseable_body';

export type CallbackVerification =
  | { ok: true; payload: CallbackPayload }
  | { ok: false; reason: CallbackRejectionReason; key: string | null };

/** A fixed secret, or a resolver — one endpoint may serve several applications. */
export type SecretSource = string | ((key: string) => string | null | Promise<string | null>);

export interface CallbackVerifierOptions {
  readonly secret: SecretSource;
  /** Seconds either side of now that `x-timestamp` may fall. The boundary is inclusive. */
  readonly tolerance?: number;
  /** Milliseconds since the epoch, as `Date.now`. */
  readonly clock?: () => number;
  readonly maxBodyBytes?: number;
}

export interface CallbackVerifyInput {
  readonly method: string;
  /** The path of the REGISTERED callback URL, query excluded — not necessarily `req.path`. */
  readonly path: string;
  readonly contentType: string;
  /** The exact received bytes. Never a re-serialized parsed body. */
  readonly body: string;
  readonly timestamp: string | null | undefined;
  readonly authorization: string | null | undefined;
}

const DEFAULT_TOLERANCE_SECONDS = 300;
const UNIX_SECONDS = /^\d+$/;

function rejected(reason: CallbackRejectionReason, key: string | null): CallbackVerification {
  return { ok: false, reason, key };
}

/** Authenticates an inbound callback against one application key pair, or a set of them. */
export class CallbackVerifier {
  readonly #secret: SecretSource;
  readonly #fixedSigner: Signer | null;
  readonly #tolerance: number;
  readonly #clock: () => number;
  readonly #maxBodyBytes: number;

  /** @throws ConfigurationError when a fixed `secret` is not canonical URL-safe base64. */
  constructor(options: CallbackVerifierOptions) {
    this.#secret = options.secret;
    // Decoded now, so a malformed fixed secret fails at wiring rather than on the first callback.
    this.#fixedSigner = typeof options.secret === 'string' ? new Signer(options.secret) : null;
    this.#tolerance = options.tolerance ?? DEFAULT_TOLERANCE_SECONDS;
    this.#clock = options.clock ?? Date.now;
    this.#maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  }

  /** Splits `Application <key>:<signature>`; two nulls for any other form. */
  static parseAuthorization(header: string | null | undefined): ParsedAuthorization {
    return parseAuthorization(header);
  }

  /** Answers about the `path` given, and never guesses an alternative one. */
  async verify(input: CallbackVerifyInput): Promise<CallbackVerification> {
    const { key, signature } = parseAuthorization(input.authorization);

    // The order below is fixed. Size first: it is the only unauthenticated-input surface, and
    // nothing should be hashed before it passes. Parsing last, after the signature verifies, so
    // an attacker's garbage body reports `signature_mismatch` instead of sending an operator to
    // debug a JSON error.
    if (bodyByteLength(input.body) > this.#maxBodyBytes) return rejected('body_too_large', key);
    if (key === null || signature === null) return rejected('missing_signature', key);

    const timestamp = input.timestamp;
    if (timestamp === null || timestamp === undefined || timestamp.trim() === '') {
      return rejected('missing_timestamp', key);
    }
    if (!this.#fresh(timestamp)) return rejected('timestamp_out_of_window', key);

    const signer = await this.#signerFor(key);
    if (signer === null) return rejected('unknown_key', key);

    const expected = signer.sign({
      method: input.method,
      path: input.path,
      contentType: input.contentType,
      body: input.body,
      // The received string verbatim: it is what the sender signed, not a number we re-render.
      timestamp,
    });
    if (!constantTimeEquals(expected, signature)) return rejected('signature_mismatch', key);

    const payload = parseCallbackPayload(input.body, key);
    if (payload === null) return rejected('unparseable_body', key);
    return { ok: true, payload };
  }

  // A header that is present but not UNIX seconds is stale rather than missing: the reason an
  // operator reads must not claim a header they can see was absent.
  #fresh(timestamp: string): boolean {
    if (!UNIX_SECONDS.test(timestamp)) return false;
    const seconds = Number(timestamp);
    if (!Number.isSafeInteger(seconds)) return false;
    return Math.abs(Math.floor(this.#clock() / 1000) - seconds) <= this.#tolerance;
  }

  async #signerFor(key: string): Promise<Signer | null> {
    if (typeof this.#secret !== 'function') return this.#fixedSigner;

    const secret: string | null | undefined = await this.#secret(key);
    // Only an absent secret is an unknown key. A blank one is a misconfigured store, and `Signer`
    // throws for it rather than answering 401 to a legitimate application forever.
    if (secret === null || secret === undefined) return null;
    return new Signer(secret);
  }
}
