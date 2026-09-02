// Repo-level gate: the SDK's inbound Authorization parser against the server side of the same
// header, implemented independently in examples/mock-api.
//
// Two parsers agreeing because one was written from the other is not evidence. These two were
// written apart, and this file is where they are made to answer the same questions -- it lives in
// scripts/ because examples/ is deliberately outside the workspace, so a package test cannot
// reach it.

import { describe, expect, it } from 'vitest';

import { parseAuthorization as sdk } from '../packages/verification-node/src/callback/authorization.ts';
import { parseAuthorization as server } from '../examples/mock-api/src/server.ts';

const HEADERS = [
  undefined,
  '',
  ' ',
  'Basic abc',
  'Application',
  'Application ',
  'Application  ',
  'Application key',
  'Application key:sig',
  'Application key:',
  'Application :sig',
  'Application :',
  'Application ::',
  'Application key:si:g',
  'Application key:sig:',
  'Application a:b:c:d',
  ' Application key:sig',
  'application key:sig',
  'APPLICATION key:sig',
  'ApplicationX key',
  'Applicationkey:sig',
  'Application  key',
  'Application key:sig ',
  'Application key :sig',
  'Application\tkey:sig',
  'Application key:sig\n',
];

// The server models Basic as well and answers with a scheme tag; only the Application scheme is
// this parser's subject, so anything else is "no application credentials", which is our null pair.
function asPair(credentials) {
  if (credentials === null || credentials.scheme === 'basic') return { key: null, signature: null };
  return { key: credentials.key, signature: credentials.signature ?? null };
}

describe('parseAuthorization against the server that emits the header', () => {
  it.each(HEADERS.map((header) => [JSON.stringify(header), header]))(
    'agrees on %s',
    (_label, header) => {
      expect(sdk(header)).toEqual(asPair(server(header)));
    },
  );

  it('covers both accepting and rejecting outcomes, so agreement is not vacuous', () => {
    const parsed = HEADERS.map((header) => sdk(header));

    expect(parsed.filter((r) => r.key !== null && r.signature !== null).length).toBeGreaterThan(0);
    expect(parsed.filter((r) => r.key !== null && r.signature === null).length).toBeGreaterThan(0);
    expect(parsed.filter((r) => r.key === null).length).toBeGreaterThan(0);
  });
});
