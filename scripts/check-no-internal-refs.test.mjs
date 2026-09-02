// Negative controls for the internal-reference gate. The scanner is a pure function
// over `{ path, content }` records, so the controls are strings rather than fixture
// repositories.
//
// Every offending literal below is assembled at runtime: written out whole, this file
// would be caught by the very gate it tests.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadPrivateRules, scanFiles } from './check-no-internal-refs.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts', 'check-no-internal-refs.mjs');

const TICKET = ['ABCD', '4321'].join('-');
const STAGING_URL = `https://${['verification', 'staging'].join('-')}.example.com`;
const TASK_KEY = ['T4', '1'].join('.');
const PHASE = ['Phase', '4'].join(' ');

const scan = (content) => scanFiles([{ path: 'sample.md', content }]);
const tokens = (content) => scan(content).map((finding) => finding.token);

function runGuard(args) {
  try {
    return {
      status: 0,
      output: execFileSync(process.execPath, [GUARD, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

describe('check-no-internal-refs', () => {
  it('passes on a file with nothing internal in it', () => {
    expect(scan('A plain sentence about signing a request.')).toEqual([]);
  });

  it('catches a tracker key and names its position', () => {
    const [finding, ...rest] = scan(`line one\nsee ${TICKET} for context\n`);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({
      path: 'sample.md',
      line: 2,
      column: 5,
      rule: 'tracker key',
      token: TICKET,
    });
  });

  // The value rules live outside this tree, so their negative controls live with them. What
  // is checkable here is the fallback: no rules, no throw -- the driver then says so on stdout.
  it('returns no private rules when they are absent, rather than throwing', () => {
    expect(loadPrivateRules('/nonexistent-root-for-this-test')).toEqual([]);
  });

  it('catches a staging URL', () => {
    const [finding, ...rest] = scan(`base: ${STAGING_URL}`);
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ rule: 'non-public environment URL', token: STAGING_URL });
  });

  // The product's own sandbox environment is documented and public; flagging it would
  // make the gate unusable and it would be switched off.
  it('leaves the public product hosts alone', () => {
    expect(scan('https://verification.didww.com/api/v1/verifications')).toEqual([]);
    expect(scan('https://verification-sandbox.didww.com/api/v1/verifications')).toEqual([]);
    expect(scan('https://registry.npmjs.org/sandbox-cli-detector/-/x-0.2.0.tgz')).toEqual([]);
  });

  it('leaves standards, licence identifiers and API levels alone', () => {
    for (const safe of [
      'UTF-8',
      'SHA-256',
      'ES-2022',
      'API-24',
      'RFC-3339',
      'ISO-8601',
      'BCP-47',
      'BSD-3-Clause',
      'MPL-2.0',
      'MIT-0',
      'CC-BY-4.0',
      'BASE64-11',
    ]) {
      expect(scan(`encoded as ${safe} here`)).toEqual([]);
    }
  });

  // These leaked past every other rule: a task key is not a tracker key, and both
  // reached public documentation while the gate stayed green.
  it('catches a plan task key and a phase number', () => {
    expect(tokens(`unblocks ${TASK_KEY} on this harness`)).toEqual([TASK_KEY]);
    expect(tokens(`gated on ${PHASE}`)).toEqual([PHASE]);
  });

  it('leaves version-like and prose numbers alone', () => {
    for (const safe of ['v1.2', 'Node 22.13', 'section 4.1', 'phase of the moon']) {
      expect(scan(`see ${safe} here`)).toEqual([]);
    }
  });

  // The allowlist must narrow the rule, not disable it.
  it('still catches a tracker key sitting among allowlisted tokens', () => {
    expect(tokens(`UTF-8 and SHA-256 and API-24, see ${TICKET}`)).toEqual([TICKET]);
  });

  it('reports a repeated token in every file, not just the first', () => {
    const findings = scanFiles([
      { path: 'a.md', content: TICKET },
      { path: 'b.md', content: TICKET },
    ]);
    expect(findings.map((finding) => finding.path)).toEqual(['a.md', 'b.md']);
  });

  it('passes on the real repository', () => {
    const { status, output } = runGuard([]);
    expect(output).toContain('the repository is clean');
    expect(status).toBe(0);
  });
});
