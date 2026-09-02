import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import express, { type ErrorRequestHandler, type Express } from 'express';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Signer } from '../signer.js';
import {
  expressCallbackHandler,
  type CallbackHandler,
  type CallbackRequestLike,
  type CallbackResponseLike,
  type ExpressCallbackHandlerOptions,
} from './express.js';
import { CallbackVerifier, type CallbackRejectionReason, type SecretSource } from './verifier.js';

// The npm alias `express4` ships no declarations of its own; the surface used here is identical
// on both majors, so express 5's types stand in for it.
const loadCjs = createRequire(import.meta.url);
const express4 = loadCjs('express4') as typeof express;

const KEY = '3f2a1c60-8b7e-4d21-9c55-0e6b1a7d4f88';
const SECRET = 'tEsT_secret_urlsafe_base64_value_AA';
const OTHER_KEY = 'c1d4e7f0-2a3b-4c5d-6e7f-8a9b0c1d2e3f';
const OTHER_SECRET = 'sEcOnD_application_secret_value_AA';
const UNKNOWN_KEY = '00000000-0000-4000-8000-000000000000';

const PATH = '/callbacks/didww';
const VERIFICATION_ID = '01920a7b-0000-7000-8000-000000000001';
const DESTINATION = '12025550143';

const BODY = JSON.stringify({
  event: 'verification_request',
  data: { id: VERIFICATION_ID, destination: DESTINATION, delivery_method: 'sms' },
});

const EXPECTED_PAYLOAD = {
  event: 'verification_request',
  key: KEY,
  data: { id: VERIFICATION_ID, destination: DESTINATION, deliveryMethod: 'sms' },
};

const applications = new Map([
  [KEY, SECRET],
  [OTHER_KEY, OTHER_SECRET],
]);
const resolver: SecretSource = (key) => applications.get(key) ?? null;

const allow: ExpressCallbackHandlerOptions['decide'] = () => ({ action: 'allow' });

const nowSeconds = (): number => Math.floor(Date.now() / 1000);

interface Wire {
  authorization: string | null;
  timestamp: string | null;
  contentType: string;
  body: string;
}

type SignedWire = Wire & { authorization: string; timestamp: string };

/** Builds an inbound callback the way the API emits one, signed with the production `Signer`. */
function signedFor(parts: {
  path: string;
  body?: string;
  key?: string;
  secret?: string;
  timestamp?: number;
  contentType?: string;
}): SignedWire {
  const body = parts.body ?? BODY;
  const contentType = parts.contentType ?? 'application/json';
  const timestamp = String(parts.timestamp ?? nowSeconds());
  const signature = new Signer(parts.secret ?? SECRET).sign({
    method: 'POST',
    path: parts.path,
    contentType,
    body,
    timestamp,
  });
  return {
    authorization: `Application ${parts.key ?? KEY}:${signature}`,
    timestamp,
    contentType,
    body,
  };
}

function serve(
  options: ExpressCallbackHandlerOptions,
  extra: { mount?: string; parser?: 'raw' | 'json' | 'text'; impl?: typeof express } = {},
): Express {
  const factory = extra.impl ?? express;
  const app = factory();
  const parser =
    extra.parser === 'json'
      ? factory.json()
      : extra.parser === 'text'
        ? factory.text({ type: '*/*' })
        : factory.raw({ type: '*/*' });

  app.post(extra.mount ?? PATH, parser, expressCallbackHandler(options));

  // Four parameters, or express does not register this as an error handler at all.
  const onError: ErrorRequestHandler = (error, _req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    res
      .status(500)
      .type('text/plain')
      .send(error instanceof Error ? error.message : 'non-error thrown');
  };
  app.use(onError);
  return app;
}

function send(app: Express, path: string, wire: Wire): request.Test {
  const pending = request(app).post(path).set('Content-Type', wire.contentType);
  if (wire.timestamp !== null) pending.set('x-timestamp', wire.timestamp);
  if (wire.authorization !== null) pending.set('Authorization', wire.authorization);
  return pending.send(wire.body);
}

interface Sent {
  status: number | null;
  body: string | undefined;
  headers: Record<string, string>;
  error: unknown;
}

/** Drives the handler without express, and resolves once it has answered or called `next`. */
async function invoke(handler: CallbackHandler, req: CallbackRequestLike): Promise<Sent> {
  return await new Promise<Sent>((resolve) => {
    const sent: Sent = { status: null, body: undefined, headers: {}, error: undefined };
    const res: CallbackResponseLike = {
      setHeader(name, value) {
        sent.headers[name] = value;
      },
      status(code) {
        sent.status = code;
        return {
          end(body) {
            sent.body = body;
            resolve(sent);
          },
        };
      },
    };
    handler(req, res, (error) => {
      sent.error = error;
      resolve(sent);
    });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('expressCallbackHandler decisions', () => {
  it.each([['allow'], ['deny']] as const)(
    'answers the API with the %s decision',
    async (action) => {
      const decide = vi.fn(() => ({ action }));
      const app = serve({ secret: SECRET, path: PATH, decide });

      const response = await send(app, PATH, signedFor({ path: PATH }));

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.text).toBe(`{"action":"${action}"}`);
      expect(decide).toHaveBeenCalledTimes(1);
      expect(decide).toHaveBeenCalledWith(
        EXPECTED_PAYLOAD,
        expect.objectContaining({ method: 'POST', originalUrl: PATH }),
      );
    },
  );

  it('verifies against the registered path, ignoring the query string', async () => {
    const verify = vi.spyOn(CallbackVerifier.prototype, 'verify');
    const app = serve({ secret: SECRET, path: 'incoming', decide: allow });

    const response = await send(app, `${PATH}?attempt=2`, signedFor({ path: PATH }));

    expect(response.status).toBe(200);
    expect(verify.mock.calls.map(([input]) => input.path)).toEqual([PATH]);
  });

  it('serves several applications through a secret resolver', async () => {
    const decide = vi.fn(allow);
    const app = serve({ secret: resolver, path: PATH, decide });

    const first = await send(app, PATH, signedFor({ path: PATH }));
    const second = await send(
      app,
      PATH,
      signedFor({ path: PATH, key: OTHER_KEY, secret: OTHER_SECRET }),
    );

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(decide.mock.calls.map(([payload]) => payload.key)).toEqual([KEY, OTHER_KEY]);
  });

  it('accepts a raw body delivered as a string', async () => {
    const app = serve({ secret: SECRET, path: PATH, decide: allow }, { parser: 'text' });

    const response = await send(app, PATH, signedFor({ path: PATH }));

    expect(response.status).toBe(200);
    expect(response.text).toBe('{"action":"allow"}');
  });

  it('applies the configured tolerance', async () => {
    const app = serve({
      secret: SECRET,
      path: PATH,
      tolerance: 1,
      decide: allow,
    });

    const response = await send(app, PATH, signedFor({ path: PATH, timestamp: nowSeconds() - 30 }));

    expect(response.status).toBe(401);
    expect(response.text).toBe('');
  });
});

describe('expressCallbackHandler path candidates', () => {
  it('accepts a bare-origin registration, signed against the empty path', async () => {
    const onRejected = vi.fn();
    const verify = vi.spyOn(CallbackVerifier.prototype, 'verify');
    const app = serve(
      { secret: SECRET, path: 'incoming', decide: allow, onRejected },
      { mount: '/' },
    );

    const response = await send(app, '/', signedFor({ path: '' }));

    expect(response.status).toBe(200);
    expect(response.text).toBe('{"action":"allow"}');
    // The first candidate's failure is internal: reporting it would put a rejection in the
    // customer's log for every callback the endpoint went on to accept.
    expect(onRejected).not.toHaveBeenCalled();
    expect(verify.mock.calls.map(([input]) => input.path)).toEqual(['/', '']);
  });

  it('still accepts the root path signed as written', async () => {
    const verify = vi.spyOn(CallbackVerifier.prototype, 'verify');
    const app = serve({ secret: SECRET, path: 'incoming', decide: allow }, { mount: '/' });

    const response = await send(app, '/', signedFor({ path: '/' }));

    expect(response.status).toBe(200);
    expect(verify.mock.calls.map(([input]) => input.path)).toEqual(['/']);
  });

  it('uses an explicit path as given and never retries another', async () => {
    const onRejected = vi.fn();
    const verify = vi.spyOn(CallbackVerifier.prototype, 'verify');
    const app = serve(
      { secret: SECRET, path: '/registered', decide: allow, onRejected },
      { mount: '/' },
    );

    const response = await send(app, '/', signedFor({ path: '' }));

    expect(response.status).toBe(401);
    expect(response.text).toBe('');
    expect(verify.mock.calls.map(([input]) => input.path)).toEqual(['/registered']);
    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledWith('signature_mismatch', expect.anything());
  });

  it('rejects a callback whose path an ingress rewrote', async () => {
    const onRejected = vi.fn();
    const verify = vi.spyOn(CallbackVerifier.prototype, 'verify');
    const app = serve(
      { secret: SECRET, path: 'incoming', decide: allow, onRejected },
      { mount: '/b' },
    );

    const response = await send(app, '/b', signedFor({ path: '/a' }));

    expect(response.status).toBe(401);
    expect(response.text).toBe('');
    expect(verify.mock.calls.map(([input]) => input.path)).toEqual(['/b']);
    expect(onRejected).toHaveBeenCalledWith('signature_mismatch', expect.anything());
  });

  it('reads a repeated header once and verifies a pathless request against the empty path', async () => {
    const verify = vi.spyOn(CallbackVerifier.prototype, 'verify');
    const handler = expressCallbackHandler({ secret: SECRET, path: 'incoming', decide: allow });
    const wire = signedFor({ path: '', contentType: '' });

    const sent = await invoke(handler, {
      method: 'POST',
      originalUrl: '',
      headers: {
        authorization: [wire.authorization, 'Application other:sig'],
        'x-timestamp': [wire.timestamp],
      },
      body: Buffer.from(wire.body, 'utf8'),
    });

    expect(sent.status).toBe(200);
    expect(sent.body).toBe('{"action":"allow"}');
    expect(sent.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(sent.error).toBeUndefined();
    expect(verify.mock.calls.map(([input]) => input.path)).toEqual(['']);
  });
});

describe('expressCallbackHandler rejections', () => {
  const oversized = JSON.stringify({
    event: 'verification_request',
    data: {
      id: VERIFICATION_ID,
      destination: DESTINATION,
      delivery_method: 'sms'.padEnd(9000, '!'),
    },
  });

  const cases: ReadonlyArray<{
    reason: CallbackRejectionReason;
    status: number;
    wire: () => Wire;
  }> = [
    {
      reason: 'missing_signature',
      status: 401,
      wire: () => ({ ...signedFor({ path: PATH }), authorization: null }),
    },
    {
      reason: 'missing_timestamp',
      status: 401,
      wire: () => ({ ...signedFor({ path: PATH }), timestamp: null }),
    },
    {
      reason: 'timestamp_out_of_window',
      status: 401,
      wire: () => signedFor({ path: PATH, timestamp: nowSeconds() - 3600 }),
    },
    {
      reason: 'unknown_key',
      status: 401,
      wire: () => signedFor({ path: PATH, key: UNKNOWN_KEY }),
    },
    {
      reason: 'signature_mismatch',
      status: 401,
      wire: () => signedFor({ path: PATH, secret: OTHER_SECRET }),
    },
    {
      reason: 'body_too_large',
      status: 400,
      wire: () => signedFor({ path: PATH, body: oversized }),
    },
    {
      reason: 'unparseable_body',
      status: 400,
      wire: () => signedFor({ path: PATH, body: 'this is not json' }),
    },
  ];

  // No `onRejected` here: the reason must never leave the process by default, since `unknown_key`
  // is decided before the signature is checked and would answer whether a key exists.
  it.each(cases)('answers $status with an empty body for $reason', async ({ status, wire }) => {
    const decide = vi.fn(allow);
    const app = serve({ secret: resolver, path: PATH, decide });

    const response = await send(app, PATH, wire());

    expect(response.status).toBe(status);
    expect(response.text).toBe('');
    expect(decide).not.toHaveBeenCalled();
  });

  it.each(cases)('reports $reason to onRejected', async ({ wire, reason }) => {
    const onRejected = vi.fn();
    const app = serve({ secret: resolver, path: PATH, decide: allow, onRejected });

    await send(app, PATH, wire());

    expect(onRejected).toHaveBeenCalledTimes(1);
    expect(onRejected).toHaveBeenCalledWith(reason, expect.objectContaining({ method: 'POST' }));
  });
});

it('runs the two-major matrix below against express 4 and express 5, not one twice', () => {
  const version = (name: string): string =>
    (loadCjs(`${name}/package.json`) as { version: string }).version;

  expect(version('express4')).toMatch(/^4\./);
  expect(version('express')).toMatch(/^5\./);
});

// Express 4 does not catch a rejected async handler: without the adapter's own try/catch these
// requests would receive no answer at all and hang until the API's read timeout.
describe.each([
  ['express 5', express],
  ['express 4', express4],
])('expressCallbackHandler error propagation on %s', (_label, impl) => {
  it('reports a missing raw body parser to the error handler', async () => {
    const app = serve({ secret: SECRET, path: PATH, decide: allow }, { parser: 'json', impl });

    const response = await send(app, PATH, signedFor({ path: PATH }));

    expect(response.status).toBe(500);
    expect(response.text).toContain("express.raw({ type: '*/*' })");
  });

  it('reports a throwing decide to the error handler', async () => {
    const app = serve(
      {
        secret: SECRET,
        path: PATH,
        decide: () => {
          throw new Error('the application store is down');
        },
      },
      { impl },
    );

    const response = await send(app, PATH, signedFor({ path: PATH }));

    expect(response.status).toBe(500);
    expect(response.text).toBe('the application store is down');
  });
});
