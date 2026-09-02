import { Buffer } from 'node:buffer';
import { ConfigurationError } from '@didww/verification-core';
import type { CallbackDecision, CallbackPayload } from './payload.js';
import { CallbackVerifier, type CallbackRejectionReason, type SecretSource } from './verifier.js';

/**
 * The part of an express request this adapter reads. Structural on purpose: this package depends
 * on core alone, so a published `.d.ts` naming express would give consumers TS7016.
 */
export interface CallbackRequestLike {
  readonly method: string;
  readonly originalUrl: string;
  readonly headers: Record<string, string | string[] | undefined>;
  /** The exact received bytes — a Buffer or a string. Never a parsed body. */
  readonly body: unknown;
}

/** The part of an express response this adapter writes. */
export interface CallbackResponseLike {
  status(code: number): { end(body?: string): void };
  setHeader(name: string, value: string): void;
}

/** An express-compatible request handler. */
export type CallbackHandler = (
  req: CallbackRequestLike,
  res: CallbackResponseLike,
  next: (err?: unknown) => void,
) => void;

export interface ExpressCallbackHandlerOptions {
  readonly secret: SecretSource;
  /**
   * The path of the REGISTERED callback URL, query excluded; the literal `'incoming'` uses the
   * received pathname instead, so that choice is visible at the call site. A registered
   * `https://example.com` signs the empty string, so its explicit value is `path: ''`.
   */
  readonly path: 'incoming' | (string & {});
  /** Seconds either side of now that `x-timestamp` may fall. Defaults to 300. */
  readonly tolerance?: number;
  readonly decide: (
    payload: CallbackPayload,
    req: CallbackRequestLike,
  ) => CallbackDecision | Promise<CallbackDecision>;
  readonly onRejected?: (reason: CallbackRejectionReason, req: CallbackRequestLike) => void;
}

const STATUS_BY_REASON: Record<CallbackRejectionReason, number> = {
  missing_signature: 401,
  missing_timestamp: 401,
  timestamp_out_of_window: 401,
  unknown_key: 401,
  signature_mismatch: 401,
  body_too_large: 400,
  unparseable_body: 400,
};

const RAW_BODY_REQUIRED =
  "The callback route needs the raw request bytes: mount `express.raw({ type: '*/*' })` on it. " +
  'A body re-serialized from express.json() is not what was signed.';

// Split rather than `new URL()`: the API signs the registered URL's path as written, so any
// percent-encoding in it has to survive verbatim.
function pathnameOf(originalUrl: string): string {
  const end = originalUrl.search(/[?#]/);
  return end === -1 ? originalUrl : originalUrl.slice(0, end);
}

// The signed path is the registered URL's path component, which is '' for a bare origin — so '/'
// and '' describe the same registered URL and both are tried before the callback is refused.
function pathCandidates(configured: string, originalUrl: string): readonly [string, string?] {
  if (configured !== 'incoming') return [configured];

  const received = pathnameOf(originalUrl);
  if (received === '/') return ['/', ''];
  if (received === '') return ['', '/'];
  return [received];
}

function header(req: CallbackRequestLike, name: string): string | null {
  const value = req.headers[name];
  return (Array.isArray(value) ? value[0] : value) ?? null;
}

function rawBody(body: unknown): string {
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body.toString('utf8');
  throw new ConfigurationError(RAW_BODY_REQUIRED);
}

/**
 * An express handler for the inbound verification callback: it authenticates the request, asks
 * `decide`, and answers the API.
 *
 * @throws ConfigurationError — through `next` — when the route is not mounted on a raw body parser.
 */
export function expressCallbackHandler(options: ExpressCallbackHandlerOptions): CallbackHandler {
  const verifier = new CallbackVerifier({
    secret: options.secret,
    ...(options.tolerance === undefined ? {} : { tolerance: options.tolerance }),
  });

  const handler: CallbackHandler = async (req, res, next) => {
    // Express 4 does not catch a rejected handler: it would answer nothing at all, the request
    // would hang until the API's read timeout, and the verification would be denied silently.
    try {
      const wire = {
        method: req.method,
        contentType: header(req, 'content-type') ?? '',
        body: rawBody(req.body),
        timestamp: header(req, 'x-timestamp'),
        authorization: header(req, 'authorization'),
      };

      const [primary, alternate] = pathCandidates(options.path, req.originalUrl);
      let result = await verifier.verify({ ...wire, path: primary });
      // The path is the only thing that differs between the two candidates, and `onRejected` must
      // not see the first failure — a bare-origin endpoint would log a rejection per accepted call.
      if (alternate !== undefined && !result.ok && result.reason === 'signature_mismatch') {
        result = await verifier.verify({ ...wire, path: alternate });
      }

      if (!result.ok) {
        options.onRejected?.(result.reason, req);
        // Status only. `unknown_key` is decided before the signature is checked, so echoing the
        // reason would turn the endpoint into an application-key oracle.
        res.status(STATUS_BY_REASON[result.reason]).end();
        return;
      }

      const decision = await options.decide(result.payload, req);
      // The decision travels in the body: the API reads `action` out of a 2xx response and treats
      // every other answer — a non-2xx, or a 2xx it cannot parse — as a denial it did not ask for.
      res.setHeader('Content-Type', 'application/json');
      res.status(200).end(JSON.stringify({ action: decision.action }));
    } catch (error) {
      next(error);
    }
  };

  return handler;
}
