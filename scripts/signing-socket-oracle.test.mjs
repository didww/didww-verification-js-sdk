// The outside answer for `application` auth. Every other signing test stops at an injected
// boundary and so proves only that our two halves agree: `Signer` produces what our own verifier
// accepts. Here the real client puts a real signed request on a real socket and
// `examples/mock-api` -- which verifies signatures independently of this SDK -- judges it.
//
// The two negative controls are what make the positives worth anything. Both send a request whose
// signature is computed correctly over the WRONG Content-Type line, using the mock's own signing
// function so that the mismatch is the only variable. If either were accepted, the mock would be
// proving nothing about the positives either.

import { createHash } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createMockApi, signature } from '../examples/mock-api/src/server.ts';
import { UnauthorizedError } from '../packages/verification-core/src/errors.ts';
import { VerificationClient } from '../packages/verification-core/src/client.ts';
import { applicationAuth } from '../packages/verification-node/src/application-auth.ts';

const KEY = 'app_signed_only';
const SECRET = 'Vs_4BEq2n7ZBe5nZIUPDAo_9RZfhl8kSBZgkCMMmvNU';
const DESTINATION = '+15551234567';

let api;
let client;

// Everything correct except the Content-Type line, which is the invariant under test.
function misSigningAuth(signedContentType) {
  return {
    headers(request) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signed = signature(SECRET, {
        method: request.method,
        contentMd5: request.body.length === 0 ? '' : contentMd5(request.body),
        contentType: signedContentType,
        timestamp,
        path: request.path,
      });
      return { Authorization: `Application ${KEY}:${signed}`, 'x-timestamp': timestamp };
    },
  };
}

function contentMd5(body) {
  return createHash('md5').update(body, 'utf8').digest('base64');
}

beforeAll(async () => {
  api = createMockApi({ port: 0 });
  await api.listen();
  client = new VerificationClient({
    baseUrl: api.url,
    auth: applicationAuth({ key: KEY, secret: SECRET }),
  });
});

afterAll(async () => {
  await api.close();
});

describe('a signed request judged by an independent verifier', () => {
  let id;

  it('accepts a signed POST carrying a body', async () => {
    const verification = await client.startVerification({
      destination: DESTINATION,
      deliveryMethod: 'sms',
    });

    expect(verification.id).toMatch(/\S/);
    expect(verification.status).toBe('pending');
    id = verification.id;
  });

  // The case the whole content-type invariant exists for: the server signs the header value it
  // received, which is '' when none was sent.
  it('accepts a signed bodyless GET', async () => {
    const verification = await client.getVerification(id);

    expect(verification.id).toBe(id);
    expect(verification.status).toBe('pending');
  });

  it('accepts a signed PUT report', async () => {
    const verification = await client.reportVerification(id, {
      deliveryMethod: 'sms',
      code: api.state.verificationCode,
    });

    expect(verification.status).toBe('verified');
  });
});

describe('the negative controls the oracle would be worthless without', () => {
  // Calibration: the same hand-rolled provider, signing the content type actually sent, is
  // accepted. Without this the rejections below could be any other defect in it.
  it('accepts the hand-rolled provider when only the content type is right', async () => {
    const bodyless = new VerificationClient({ baseUrl: api.url, auth: misSigningAuth('') });
    const withBody = new VerificationClient({
      baseUrl: api.url,
      auth: misSigningAuth('application/json'),
    });

    const started = await withBody.startVerification({
      destination: DESTINATION,
      deliveryMethod: 'sms',
    });
    await expect(bodyless.getVerification(started.id)).resolves.toMatchObject({ id: started.id });
  });

  it('rejects a GET signed over application/json that sends no Content-Type', async () => {
    const wrong = new VerificationClient({
      baseUrl: api.url,
      auth: misSigningAuth('application/json'),
    });

    await expect(wrong.getVerification('ver_missing')).rejects.toBeInstanceOf(UnauthorizedError);
  });

  it('rejects a POST that sends Content-Type but was signed over an empty one', async () => {
    const wrong = new VerificationClient({ baseUrl: api.url, auth: misSigningAuth('') });

    await expect(
      wrong.startVerification({ destination: DESTINATION, deliveryMethod: 'sms' }),
    ).rejects.toBeInstanceOf(UnauthorizedError);
  });
});
