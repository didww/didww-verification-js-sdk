import { describe, expect, it } from 'vitest';
import { parseAuthorization } from './authorization.js';

const NONE = { key: null, signature: null };
const KEY = '3f2a1c60-8b7e-4d21-9c55-0e6b1a7d4f88';
const SIGNATURE = 'GjE0mS7kQ1vXk4l2yTn8pR6cB9dA3fH5uZ0wV7xY2sQ=';

describe('parseAuthorization', () => {
  it.each([
    ['a missing header', null, NONE],
    ['an undefined header', undefined, NONE],
    ['an empty header', '', NONE],
    ['another scheme', 'Basic abc', NONE],
    ['the scheme with no separating space', 'Application', NONE],
    ['a scheme-like prefix', 'ApplicationX key', NONE],
    ['the scheme with an empty token', 'Application ', NONE],
    ['a public header', 'Application key', { key: 'key', signature: null }],
    ['a signed header', 'Application key:sig', { key: 'key', signature: 'sig' }],
    ['an empty signature', 'Application key:', NONE],
    ['an empty key', 'Application :sig', NONE],
    ['a colon inside the signature', 'Application key:si:g', { key: 'key', signature: 'si:g' }],
    ['a signature ending in a colon', 'Application key:sig:', { key: 'key', signature: 'sig:' }],
    ['leading whitespace', ' Application key:sig', NONE],
    ['a lowercase scheme', 'application key:sig', NONE],
    ['an uppercase scheme', 'APPLICATION key:sig', NONE],
    ['real credentials', `Application ${KEY}:${SIGNATURE}`, { key: KEY, signature: SIGNATURE }],
  ])('parses %s', (_label, header, expected) => {
    expect(parseAuthorization(header)).toEqual(expected);
  });

  it('keeps whitespace inside the token rather than trimming it', () => {
    // A signature carrying a trailing space is 45 characters and fails the comparison, which is
    // the wanted outcome: the header is not what the server sent.
    expect(parseAuthorization('Application key:sig ')).toEqual({ key: 'key', signature: 'sig ' });
    expect(parseAuthorization('Application  key')).toEqual({ key: ' key', signature: null });
  });

  it('treats only the empty token as absent, not a whitespace-only one', () => {
    // Such a key resolves to no application and is rejected a step later.
    expect(parseAuthorization('Application   ')).toEqual({ key: '  ', signature: null });
  });
});
