import { createHash } from 'node:crypto';
import { ConfigurationError } from '@didww/verification-core';
import { describe, expect, it } from 'vitest';
import { Signer, type SignInput } from './signer.js';

const SECRET = 'tEsT_secret_urlsafe_base64_value_AA';
const TIMESTAMP = 1700000000;

const POST: SignInput = {
  method: 'POST',
  path: '/verifications',
  contentType: 'application/json',
  body: '{"key":"value"}',
  timestamp: TIMESTAMP,
};

const GET: SignInput = {
  method: 'GET',
  path: '/verifications',
  contentType: '',
  body: '',
  timestamp: TIMESTAMP,
};

const BODY_MD5 = 'pzU/fN3OgI3gAydHoLe+UA==';

const signer = new Signer(SECRET);

describe('Signer', () => {
  // The vectors, and only these, have an oracle outside this repository. Both the string and the
  // signature are asserted: the signature alone cannot say which of the five lines moved.
  describe('the ported vectors', () => {
    it('signs the POST vector', () => {
      expect(signer.stringToSign(POST)).toBe(
        'POST\npzU/fN3OgI3gAydHoLe+UA==\napplication/json\nx-timestamp:1700000000\n/verifications',
      );
      expect(signer.sign(POST)).toBe('k7TRVTzybQtVKYdpgKNd2QxH5n2LvQselVWSMOlYPo8=');
    });

    it('signs the bodyless GET vector', () => {
      expect(signer.stringToSign(GET)).toBe('GET\n\n\nx-timestamp:1700000000\n/verifications');
      expect(signer.sign(GET)).toBe('kCJ2eLWCrmKMhEsBFRL1A8HcmBTozeljcfOy5i+kVZU=');
    });
  });

  it('leaves both the CONTENT-MD5 and the Content-Type line empty on a bodyless request', () => {
    // A transport that defaults Content-Type breaks exactly this: the server signs what Rack
    // reports, which is '' when no header was sent.
    const lines = signer.stringToSign(GET).split('\n');

    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('');
  });

  it('puts a CONTENT-MD5 matching an independently computed digest on line two', () => {
    // Computed here rather than through the signer, so one wrong helper cannot satisfy both sides.
    expect(createHash('md5').update(POST.body, 'utf8').digest('base64')).toBe(BODY_MD5);
    expect(signer.stringToSign(POST).split('\n')[1]).toBe(BODY_MD5);
  });

  it('signs a trailing space in the body as a different request', () => {
    const padded = signer.sign({ ...POST, body: `${POST.body} ` });

    expect(padded).not.toBe(signer.sign(POST));
  });

  describe('CONTENT-MD5 at the empty-body boundary', () => {
    it('omits the digest for an empty body', () => {
      expect(signer.stringToSign({ ...POST, body: '' }).split('\n')[1]).toBe('');
    });

    it('digests a whitespace-only body, which the server would omit', () => {
      expect(signer.stringToSign({ ...POST, body: ' ' }).split('\n')[1]).toBe(
        'chXunH2dwinSkhpA6JnsXw==',
      );
    });
  });

  it('upcases the method', () => {
    // Asserted on Signer, not through the client: the client's method type is a closed upper-case
    // union, so a proof there would be unreachable. This is for standalone callers.
    expect(signer.stringToSign({ ...POST, method: 'post' })).toBe(signer.stringToSign(POST));
    expect(signer.sign({ ...POST, method: 'post' })).toBe(signer.sign(POST));
  });

  it('treats a numeric and a string timestamp of the same value alike', () => {
    expect(signer.sign({ ...POST, timestamp: '1700000000' })).toBe(signer.sign(POST));
  });

  it.each([
    ['a blank secret', ''],
    ['a non-canonical encoding', 'tEsT_secret_urlsafe_base64_value_AB'],
    ['the standard base64 alphabet', 'tEsT+secret/urlsafe_base64_value_AA'],
  ])('rejects %s when constructed, before anything is signed', (_label, secret) => {
    expect(() => new Signer(secret)).toThrow(ConfigurationError);
  });
});
