import { describe, expect, it } from 'vitest';
import type { HttpRequest, HttpResponse } from '../transport.js';
import { fakeTransport } from './index.js';

function get(path: string): HttpRequest {
  return { method: 'GET', url: `https://api.example.test${path}`, path, headers: {} };
}

function response(status: number, body = ''): HttpResponse {
  return { status, headers: {}, body };
}

describe('fakeTransport', () => {
  it('returns scripted responses in order', async () => {
    const { transport } = fakeTransport([response(200, 'first'), response(201, 'second')]);
    await expect(transport(get('/a'))).resolves.toEqual(response(200, 'first'));
    await expect(transport(get('/b'))).resolves.toEqual(response(201, 'second'));
  });

  it('passes the actual request to a function entry and delivers its return value', async () => {
    const { transport } = fakeTransport([(req) => response(200, `echo:${req.path}`)]);
    const result = await transport(get('/echo'));
    expect(result.body).toBe('echo:/echo');
  });

  it('supports a mixed script of static and function entries', async () => {
    const { transport } = fakeTransport([
      response(200, 'static'),
      (req) => response(200, `dynamic:${req.path}`),
    ]);
    await expect(transport(get('/a'))).resolves.toEqual(response(200, 'static'));
    const second = await transport(get('/b'));
    expect(second.body).toBe('dynamic:/b');
  });

  it('records the exact bodyless request handed to it, with no Content-Type key and no body key', async () => {
    const { transport, requests } = fakeTransport([response(200)]);
    const sent = get('/no-body');

    await transport(sent);

    expect(requests[0]).toBe(sent);
    expect('Content-Type' in sent.headers).toBe(false);
    expect('content-type' in sent.headers).toBe(false);
    expect(sent.body).toBeUndefined();
    expect(Object.hasOwn(sent, 'body')).toBe(false);
  });

  it('exposes requests live, between calls, not only after the last one', async () => {
    const { transport, requests } = fakeTransport([response(200), response(200)]);
    expect(requests).toHaveLength(0);

    await transport(get('/a'));
    expect(requests).toHaveLength(1);

    await transport(get('/b'));
    expect(requests).toHaveLength(2);
  });

  it('throws, naming the offending request, once the script is exhausted', async () => {
    const { transport } = fakeTransport([response(200)]);
    await transport(get('/first'));

    await expect(transport(get('/second'))).rejects.toThrow(/GET.*\/second/);
  });

  it('throws on the very first request when the script is empty', async () => {
    const { transport } = fakeTransport([]);
    await expect(transport(get('/anything'))).rejects.toThrow(/GET.*\/anything/);
  });
});
