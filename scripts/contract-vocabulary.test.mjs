// Contract facts the published packages hard-code, checked against the snapshot -- plus the
// vocabulary invariants that need no oracle at all.
//
// The slug catalogues themselves are no longer duplicated in the snapshot: the arrays exported
// from `@didww/verification-core` are the SDK's only statement of them, and `contract-check`
// compares those against a freshly generated API specification at release. What remains here is
// everything a running client cannot read from a file: constants compiled into the package, and
// relationships between the arrays that hold regardless of what the service says.
//
// This lives at the repository root rather than beside the arrays because reading the snapshot
// needs Node, and `packages/verification-core` deliberately compiles with `types: []` so that no
// Node global can reach a package that also runs on Hermes.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  API_ERROR_CODES,
  VERIFICATION_ERROR_CODES,
} from '../packages/verification-core/src/error-codes.ts';
import { PRODUCTION_BASE_URL, SANDBOX_BASE_URL } from '../packages/verification-core/src/client.ts';
import { APP_HASH_PATTERN } from '../packages/verification-core/src/wire.ts';
import { extractCode } from '../packages/verification-react-native/src/sms/extractor.ts';
import { SMS_TEMPLATES } from '../examples/mock-api/src/state.ts';

const snapshot = JSON.parse(
  readFileSync(fileURLToPath(new URL('../contract/wire-contract.json', import.meta.url)), 'utf8'),
);

describe('invariants between the exported arrays', () => {
  it('API_ERROR_CODES has no duplicates', () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });

  // The outcome codes are the 9 that arrive as `error_code` on a finished verification; they are
  // also members of the envelope catalogue. check-slug-parity reads the same relationship as the
  // 22/9 split axis it diffs the Kotlin and Swift SDKs on, so a drift here silently redefines it.
  it('every VERIFICATION_ERROR_CODE is in API_ERROR_CODES, in the same relative order', () => {
    const outcome = new Set(VERIFICATION_ERROR_CODES);

    expect(API_ERROR_CODES.filter((code) => outcome.has(code))).toEqual([
      ...VERIFICATION_ERROR_CODES,
    ]);
  });
});

// The client cannot read the snapshot at runtime, so these are constants in the package and can
// drift from it.
describe('constants that a published package cannot read from the snapshot', () => {
  it('the base URLs match baseUrls', () => {
    expect({ production: PRODUCTION_BASE_URL, sandbox: SANDBOX_BASE_URL }).toEqual(
      snapshot.baseUrls,
    );
  });

  it('the app-hash gate matches constraints.appHash', () => {
    expect(APP_HASH_PATTERN.source).toBe(new RegExp(snapshot.constraints.appHash.pattern).source);
  });
});

// The placeholder is the one piece of the template format a client has to hard-code, and nothing
// else in the toolchain compares the three places it appears. It drifted once already: the mock
// rendered a lower-case token while the service emits an upper-case one, so every extraction
// against the mock returned null and fell silently through to manual entry.
describe('the code placeholder, which three things must agree on', () => {
  const token = snapshot.constraints.codePlaceholder.token;

  it('the extractor splits on the token the snapshot records', () => {
    const rendered = `Your code is 123456. Do not share it.`;
    expect(extractCode(`Your code is ${token}. Do not share it.`, rendered)).toBe('123456');
  });

  it('rejects a token differing only in case, so the comparison is not accidentally loose', () => {
    const wrong = token.toLowerCase();

    expect(wrong).not.toBe(token);
    expect(extractCode(`Your code is ${wrong}.`, 'Your code is 123456.')).toBeNull();
  });

  it('every mock template carries it exactly once', () => {
    const templates = Object.values(SMS_TEMPLATES);

    expect(templates.length).toBeGreaterThan(0);
    for (const template of templates) {
      expect(template.split(token)).toHaveLength(2);
    }
  });
});
