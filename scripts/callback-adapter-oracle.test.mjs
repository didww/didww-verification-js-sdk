// The inbound gate end to end: the express adapter on a real socket, receiving callbacks the API
// really signed and sent, and the verification outcome the API reached as a result.
//
// The adapter's own suite drives it with supertest, which is an injected boundary -- it proves the
// handler answers, not that the answer is the one the sender needs. Two things are only visible
// from here: that a 2xx must CARRY the decision (an empty body is read as a denial nobody asked
// for), and that the bare-origin retry works against a real bare-origin registration.

import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { createMockApi } from '../examples/mock-api/src/server.ts';
import { expressCallbackHandler } from '../packages/verification-node/src/callback/express.ts';

const KEY = 'cb_app';
const SECRET = 'N_LcOP92KN816zeNCr7QBecO5JR1vuhZ-wAVeTrC5TM';

const closers = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()();
});

async function mountAdapter({ route, path, action }) {
  const events = [];
  const app = express();
  app.post(
    route,
    express.raw({ type: '*/*' }),
    expressCallbackHandler({
      secret: SECRET,
      path,
      decide: (payload) => {
        events.push({ kind: 'decide', payload });
        return { action };
      },
      onRejected: (reason) => events.push({ kind: 'rejected', reason }),
    }),
  );

  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return { events, port: server.address().port };
}

async function startVerificationCallingBack(callbackUrl) {
  const api = createMockApi({
    port: 0,
    applications: [{ key: KEY, secret: SECRET, minimumScheme: 'public', callbackUrl }],
  });
  await api.listen();
  closers.push(() => api.close());

  const response = await fetch(`${api.url}/api/v1/verifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Application ${KEY}` },
    body: JSON.stringify({ data: { destination: '+15551230000', delivery_method: 'sms' } }),
  });
  return (await response.json()).data;
}

describe('expressCallbackHandler against callbacks the API signs and sends', () => {
  it('lets an allowed verification proceed, which requires the decision to be in the body', async () => {
    const adapter = await mountAdapter({ route: '/cb', path: '/cb', action: 'allow' });

    const verification = await startVerificationCallingBack(`http://127.0.0.1:${adapter.port}/cb`);

    expect(verification.status).toBe('pending');
    expect(verification.error_code).toBeNull();
    expect(adapter.events).toEqual([
      { kind: 'decide', payload: expect.objectContaining({ key: KEY }) },
    ]);
  });

  it('denies the verification when the endpoint says deny', async () => {
    const adapter = await mountAdapter({ route: '/cb', path: '/cb', action: 'deny' });

    const verification = await startVerificationCallingBack(`http://127.0.0.1:${adapter.port}/cb`);

    expect(verification.status).toBe('denied');
    expect(verification.error_code).toBe('denied_by_callback');
  });

  // The registered URL has no path, so the API signs '' while express reports '/'. Without the
  // two-candidate retry this denies every verification, with valid signatures on both sides.
  it('accepts a bare-origin registration without reporting a rejection', async () => {
    const adapter = await mountAdapter({ route: '/', path: 'incoming', action: 'allow' });

    const verification = await startVerificationCallingBack(`http://127.0.0.1:${adapter.port}`);

    expect(verification.status).toBe('pending');
    expect(adapter.events.filter((event) => event.kind === 'rejected')).toEqual([]);
    expect(adapter.events).toHaveLength(1);
  });

  // The control, and the misconfiguration it models: the endpoint is told a registered path that
  // is not the one the API signed. An explicit path is used as given and never second-guessed, so
  // this must be refused rather than rescued by the bare-origin retry.
  it('rejects when the configured path is not the one signed, and never asks decide', async () => {
    const adapter = await mountAdapter({
      route: '/cb',
      path: '/not-the-registered-path',
      action: 'allow',
    });

    const verification = await startVerificationCallingBack(`http://127.0.0.1:${adapter.port}/cb`);

    expect(verification.status).toBe('denied');
    expect(verification.error_code).toBe('denied_invalid_callback_response');
    expect(adapter.events).toEqual([{ kind: 'rejected', reason: 'signature_mismatch' }]);
  });
});
