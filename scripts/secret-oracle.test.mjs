// Repo-level gate: `decodeSecret` against the server's own base64 decoder.
//
// The subject is an agreement with software outside this repository, so a proof written against
// our own decoder proves only that it is deterministic. The verdicts in the fixture were produced
// once by the interpreter the service pins and committed; nothing here shells out to ruby, which
// CI does not have.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { decodeSecret } from '../packages/verification-node/src/secret.ts';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const oracle = JSON.parse(
  readFileSync(path.join(root, 'scripts/__fixtures__/secret-oracle.json'), 'utf8'),
);

function verdictOf(value) {
  try {
    return `OK ${decodeSecret(value).length}`;
  } catch {
    return 'REJECT';
  }
}

describe('decodeSecret against the recorded server verdicts', () => {
  it('carries a corpus wide enough to be worth running', () => {
    expect(oracle.vectors.length).toBeGreaterThanOrEqual(200);
    expect(oracle.vectors.some((v) => v.sdk.startsWith('OK'))).toBe(true);
    expect(oracle.vectors.some((v) => v.sdk === 'REJECT')).toBe(true);
  });

  it('agrees with the server on every vector but the deliberate divergences', () => {
    const unexpected = oracle.vectors
      .filter((v) => v.ruby !== v.sdk && v.deliberateDivergence === undefined)
      .map((v) => v.value);

    expect(unexpected).toEqual([]);
  });

  it('diverges only where a reason is recorded, and every recorded reason is real', () => {
    const declared = oracle.vectors.filter((v) => v.deliberateDivergence !== undefined);

    expect(declared.length).toBeGreaterThan(0);
    // A divergence that stopped diverging is a stale exemption, and it hides the next real one.
    expect(declared.filter((v) => v.ruby === v.sdk)).toEqual([]);
  });

  it.each(oracle.vectors.map((v) => [JSON.stringify(v.value), v]))(
    'decodes %s as recorded',
    (_label, vector) => {
      expect(verdictOf(vector.value)).toBe(vector.sdk);
    },
  );
});
