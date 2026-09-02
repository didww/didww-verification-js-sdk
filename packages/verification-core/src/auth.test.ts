import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { basicAuth, publicAuth, type AuthProvider, type AuthRequest } from './auth.js';
import { ConfigurationError } from './errors.js';

const getRequest: AuthRequest = {
  method: 'GET',
  path: '/api/v1/verifications/abc',
  contentType: '',
  body: '',
};

const postRequest: AuthRequest = {
  method: 'POST',
  path: '/api/v1/verifications',
  contentType: 'application/json',
  body: '{"identity":{"number":"+4915112345"}}',
};

/** `__DEV__` is a Metro-injected global; under vitest it is simply absent unless a test sets it. */
const metroGlobals = globalThis as unknown as { __DEV__?: boolean };

function setDevGlobal(value: boolean | undefined): void {
  if (value === undefined) {
    delete metroGlobals.__DEV__;
  } else {
    metroGlobals.__DEV__ = value;
  }
}

beforeEach(() => {
  setDevGlobal(undefined);
});

afterEach(() => {
  setDevGlobal(undefined);
  vi.restoreAllMocks();
});

describe('basicAuth', () => {
  it('encodes key and secret as a Basic credential', async () => {
    const headers = await basicAuth('key', 'secret').headers(getRequest);

    expect(headers).toEqual({ Authorization: 'Basic a2V5OnNlY3JldA==' });
  });

  it('encodes a non-ASCII secret as UTF-8', async () => {
    const headers = await basicAuth('ak_live_9f3c', 's3cr3t-pässwörd/+=').headers(postRequest);

    expect(headers).toEqual({
      Authorization: 'Basic YWtfbGl2ZV85ZjNjOnMzY3IzdC1ww6Rzc3fDtnJkLys9',
    });
  });

  it('sends nothing but Authorization, on any request shape', async () => {
    const provider = basicAuth('key', 'secret');

    for (const request of [getRequest, postRequest]) {
      expect(Object.keys(await provider.headers(request))).toEqual(['Authorization']);
    }
  });

  it.each([
    ['a key containing a colon', 'ak:live', 'secret'],
    ['a key that is only a colon', ':', 'secret'],
    ['an empty key', '', 'secret'],
    ['a whitespace-only key', '   ', 'secret'],
    ['an empty secret', 'key', ''],
    ['a whitespace-only secret', 'key', '  '],
  ])('rejects %s with ConfigurationError', (_label, key, secret) => {
    expect(() => basicAuth(key, secret)).toThrow(ConfigurationError);
  });

  it('rejects a colon in the key before any request is built', () => {
    expect(() => basicAuth('ak:live', 'secret')).toThrow(/must not contain ":"/);
  });
});

describe('publicAuth', () => {
  it('sends the key unsigned', async () => {
    const headers = await publicAuth('ak_live_9f3c').headers(getRequest);

    expect(headers).toEqual({ Authorization: 'Application ak_live_9f3c' });
  });

  it('emits no colon — a colon would select the signed scheme', async () => {
    const headers = await publicAuth('ak_live_9f3c').headers(postRequest);

    expect(headers['Authorization']).not.toContain(':');
  });

  it('emits no x-timestamp — that header belongs to the signed scheme', async () => {
    const provider = publicAuth('ak_live_9f3c');

    for (const request of [getRequest, postRequest]) {
      const names = Object.keys(await provider.headers(request)).map((name) => name.toLowerCase());
      expect(names).toEqual(['authorization']);
    }
  });

  it.each([
    ['a key containing a colon', 'ak_live_9f3c:deadbeef'],
    ['a key that is only a colon', ':'],
    ['an empty key', ''],
    ['a whitespace-only key', '\t '],
  ])('rejects %s with ConfigurationError', (_label, key) => {
    expect(() => publicAuth(key)).toThrow(ConfigurationError);
  });

  it('rejects a colon in the key before any request is built', () => {
    expect(() => publicAuth('ak_live_9f3c:deadbeef')).toThrow(/must not contain ":"/);
  });
});

describe('the release-build warning', () => {
  it('warns once per provider when __DEV__ is false', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDevGlobal(false);

    const provider = basicAuth('key', 'secret');
    await provider.headers(getRequest);
    await provider.headers(postRequest);

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('basicAuth sends your API secret');
  });

  it('warns once per provider, not once per process', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDevGlobal(false);

    basicAuth('key', 'secret');
    basicAuth('other', 'secret');

    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('stays quiet when __DEV__ is true', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDevGlobal(true);

    basicAuth('key', 'secret');

    expect(warn).not.toHaveBeenCalled();
  });

  it('does not throw a ReferenceError when __DEV__ is not defined at all', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDevGlobal(undefined);
    expect('__DEV__' in metroGlobals).toBe(false);

    expect(() => basicAuth('key', 'secret')).not.toThrow();
    expect(warn).not.toHaveBeenCalled();
  });

  it('never warns for publicAuth — the key is not a secret', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setDevGlobal(false);

    publicAuth('ak_live_9f3c');

    expect(warn).not.toHaveBeenCalled();
  });
});

describe('the AuthProvider seam', () => {
  /** Stands in for the client: whatever consumes a provider must await `headers()`. */
  async function consume(
    provider: AuthProvider,
    request: AuthRequest,
  ): Promise<Record<string, string>> {
    return await provider.headers(request);
  }

  it('awaits an async provider', async () => {
    const provider: AuthProvider = {
      headers: async (request) => {
        await Promise.resolve();
        return { Authorization: `Remote ${request.method}` };
      },
    };

    expect(provider.headers(getRequest)).toBeInstanceOf(Promise);
    await expect(consume(provider, getRequest)).resolves.toEqual({ Authorization: 'Remote GET' });
  });

  it('accepts a synchronous provider through the same path', async () => {
    const provider = publicAuth('ak_live_9f3c');

    expect(provider.headers(getRequest)).not.toBeInstanceOf(Promise);
    await expect(consume(provider, getRequest)).resolves.toEqual({
      Authorization: 'Application ak_live_9f3c',
    });
  });
});
