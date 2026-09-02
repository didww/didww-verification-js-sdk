// Asserts the bytes that leave the process, not the init object handed to an injected `fetch`.
// The unit tests check what `fetchTransport` does; only a socket can show what the runtime then
// does with it — `fetch` synthesises `text/plain;charset=UTF-8` for a string body whose caller set
// no Content-Type, which the init object never shows.
//
// This lives at the repository root rather than beside the transport because standing up a server
// needs Node, and `packages/verification-core` deliberately compiles with `types: []` so that no
// Node global can reach a package that also runs on Hermes.

import { createServer } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConfigurationError } from '../packages/verification-core/src/errors.ts';
import { fetchTransport } from '../packages/verification-core/src/transport.ts';

// Added by `fetch` or by HTTP itself, and none of them is an input to the signature.
const UNSIGNED_ADDITIONS = new Set([
  'accept',
  'accept-encoding',
  'accept-language',
  'connection',
  'content-length',
  'host',
  'sec-fetch-mode',
  'user-agent',
]);

let server;
let origin;
let received;

beforeAll(async () => {
  received = [];
  server = createServer((req, res) => {
    received.push({ method: req.method, url: req.url, headers: { ...req.headers } });
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"abc"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

const transport = fetchTransport();
const lastRequest = () => received[received.length - 1];

describe('fetchTransport on the wire', () => {
  it('sends no Content-Type at all on a bodyless GET', async () => {
    const response = await transport({
      method: 'GET',
      url: `${origin}/v1/verifications/abc`,
      path: '/v1/verifications/abc',
      headers: { Authorization: 'Application key:sig', 'x-timestamp': '1700000000' },
    });

    expect(response.status).toBe(200);
    const request = lastRequest();
    expect('content-type' in request.headers).toBe(false);
    expect(request.method).toBe('GET');
    expect(request.url).toBe('/v1/verifications/abc');
    expect(request.headers['x-timestamp']).toBe('1700000000');
    expect(request.headers.authorization).toBe('Application key:sig');
  });

  it('adds nothing to a bodyless GET that could reach the signed string', async () => {
    await transport({
      method: 'GET',
      url: `${origin}/v1/verifications/abc`,
      path: '/v1/verifications/abc',
      headers: { Authorization: 'Application key:sig', 'x-timestamp': '1700000000' },
    });

    const sent = new Set(['authorization', 'x-timestamp']);
    const unexpected = Object.keys(lastRequest().headers).filter(
      (name) => !sent.has(name) && !UNSIGNED_ADDITIONS.has(name),
    );
    expect(unexpected).toEqual([]);
  });

  it('keeps the parameters of a Content-Type verbatim on the wire', async () => {
    await transport({
      method: 'POST',
      url: `${origin}/v1/verifications`,
      path: '/v1/verifications',
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'x-timestamp': '1700000000' },
      body: '{"identity":{"endpoint":"+15551234567"}}',
    });

    expect(lastRequest().headers['content-type']).toBe('application/json; charset=utf-8');
  });

  it('sends an unparameterised Content-Type exactly as given', async () => {
    await transport({
      method: 'PUT',
      url: `${origin}/v1/verifications/abc`,
      path: '/v1/verifications/abc',
      headers: { 'Content-Type': 'application/json', 'x-timestamp': '1700000000' },
      body: '{"code":"1234"}',
    });

    expect(lastRequest().headers['content-type']).toBe('application/json');
  });

  it('refuses a bodyless request that carries a Content-Type', async () => {
    const before = received.length;

    await expect(
      transport({
        method: 'GET',
        url: `${origin}/v1/verifications/abc`,
        path: '/v1/verifications/abc',
        headers: { 'Content-Type': 'application/json', 'x-timestamp': '1700000000' },
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);

    expect(received).toHaveLength(before);
  });

  it('refuses a body with no Content-Type rather than letting fetch retype it', async () => {
    const before = received.length;

    await expect(
      transport({
        method: 'POST',
        url: `${origin}/v1/verifications`,
        path: '/v1/verifications',
        headers: { 'x-timestamp': '1700000000' },
        body: '{"identity":{"endpoint":"+15551234567"}}',
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);

    expect(received).toHaveLength(before);
  });
});
