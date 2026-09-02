// The outside answer for the inbound callback gate. Every verifier test signs its fixtures with
// the same Signer the verifier checks them with, so it proves the two agree and nothing more.
// Here `examples/mock-api` -- which signs outbound callbacks independently of this SDK -- sends
// real ones over a real socket, and CallbackVerifier judges them.
//
// The bare-origin case is the reason this is worth running. A registered URL with no path is
// signed over the EMPTY STRING, not over '/', and a receiver that verifies the pathname it was
// called on denies every verification with a valid signature computed on both sides.

import { createServer } from 'node:http';

import { afterEach, describe, expect, it } from 'vitest';

import { createMockApi } from '../examples/mock-api/src/server.ts';
import { CallbackVerifier } from '../packages/verification-node/src/callback/verifier.ts';

const KEY = 'cb_app';
const SECRET = 'N_LcOP92KN816zeNCr7QBecO5JR1vuhZ-wAVeTrC5TM';

const closers = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()();
});

// Answers `allow` to whatever arrives and records what the verifier made of it.
async function startReceiver(registeredPath, secretForVerifier) {
  const verifier = new CallbackVerifier({ secret: secretForVerifier });
  const verdicts = [];

  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      void (async () => {
        verdicts.push(
          await verifier.verify({
            method: request.method ?? 'POST',
            path: registeredPath,
            contentType: request.headers['content-type'] ?? '',
            body: Buffer.concat(chunks).toString('utf8'),
            timestamp: request.headers['x-timestamp'] ?? null,
            authorization: request.headers['authorization'] ?? null,
          }),
        );
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ action: 'allow' }));
      })();
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => new Promise((resolve) => server.close(resolve)));
  return { verdicts, port: server.address().port };
}

async function startApiCallingBack(callbackUrl) {
  const api = createMockApi({
    port: 0,
    applications: [{ key: KEY, secret: SECRET, minimumScheme: 'public', callbackUrl }],
  });
  await api.listen();
  closers.push(() => api.close());
  return api;
}

async function triggerCallback(api, destination) {
  return fetch(`${api.url}/api/v1/verifications`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Application ${KEY}` },
    body: JSON.stringify({ data: { destination, delivery_method: 'sms' } }),
  });
}

describe('CallbackVerifier against callbacks the API actually signs and sends', () => {
  it('accepts one sent to a registered URL with a path', async () => {
    const receiver = await startReceiver('/callbacks/verification', SECRET);
    const api = await startApiCallingBack(
      `http://127.0.0.1:${receiver.port}/callbacks/verification`,
    );

    const started = await triggerCallback(api, '+15551234567');

    expect(started.status).toBe(201);
    expect(receiver.verdicts).toHaveLength(1);
    expect(receiver.verdicts[0]).toEqual({
      ok: true,
      payload: {
        event: 'verification_request',
        key: KEY,
        data: { id: expect.any(String), destination: '15551234567', deliveryMethod: 'sms' },
      },
    });
  });

  it('accepts one sent to a bare origin, whose signed path is the empty string', async () => {
    const receiver = await startReceiver('', SECRET);
    const api = await startApiCallingBack(`http://127.0.0.1:${receiver.port}`);

    await triggerCallback(api, '+15551234568');

    expect(receiver.verdicts).toHaveLength(1);
    expect(receiver.verdicts[0].ok).toBe(true);
  });

  // The control: without it, the two acceptances above could mean the verifier accepts anything.
  it('rejects the same bare-origin callback when the receiver verifies "/" instead', async () => {
    const receiver = await startReceiver('/', SECRET);
    const api = await startApiCallingBack(`http://127.0.0.1:${receiver.port}`);

    await triggerCallback(api, '+15551234569');

    expect(receiver.verdicts).toHaveLength(1);
    expect(receiver.verdicts[0]).toMatchObject({ ok: false, reason: 'signature_mismatch' });
  });

  it('rejects one whose secret does not match the sender', async () => {
    const receiver = await startReceiver(
      '/callbacks/verification',
      'Vs_4BEq2n7ZBe5nZIUPDAo_9RZfhl8kSBZgkCMMmvNU',
    );
    const api = await startApiCallingBack(
      `http://127.0.0.1:${receiver.port}/callbacks/verification`,
    );

    await triggerCallback(api, '+15551234570');

    expect(receiver.verdicts).toHaveLength(1);
    expect(receiver.verdicts[0]).toMatchObject({ ok: false, reason: 'signature_mismatch' });
  });
});
