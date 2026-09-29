// Negative controls for the version-constants gate. The checking logic is a pure function over a
// parsed manifest version and raw `version.ts` source, so each control is one field changed on an
// otherwise-valid input rather than a fixture repository.

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkVersionConstants } from './check-version-constants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts', 'check-version-constants.mjs');

function base() {
  return { manifestVersion: '1.0.0', versionSource: "export const CORE_VERSION = '1.0.0';\n" };
}

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

describe('checkVersionConstants', () => {
  it('passes when the constant matches package.json', () => {
    expect(checkVersionConstants(base())).toEqual([]);
  });

  it('rejects a constant that drifted from package.json', () => {
    const failures = checkVersionConstants({ ...base(), manifestVersion: '1.1.0' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('CORE_VERSION is "1.0.0"');
    expect(failures[0]).toContain('package.json\'s version is "1.1.0"');
  });

  it('rejects a version.ts that does not export the expected constant', () => {
    const failures = checkVersionConstants({
      ...base(),
      versionSource: "export const WRONG_NAME = '1.0.0';\n",
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("does not export `const CORE_VERSION = '<version>'`");
  });

  it('ignores a commented-out declaration and reads the real export instead', () => {
    const failures = checkVersionConstants({
      manifestVersion: '1.0.0',
      versionSource:
        "// export const CORE_VERSION = '0.9.0';\nexport const CORE_VERSION = '1.0.0';\n",
    });
    expect(failures).toEqual([]);
  });

  it('rejects when only a commented-out declaration matches package.json', () => {
    const failures = checkVersionConstants({
      manifestVersion: '0.9.0',
      versionSource:
        "// export const CORE_VERSION = '0.9.0';\nexport const CORE_VERSION = '1.0.0';\n",
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('CORE_VERSION is "1.0.0"');
    expect(failures[0]).toContain('package.json\'s version is "0.9.0"');
  });

  it('rejects when only a declaration inside a block comment matches package.json', () => {
    const failures = checkVersionConstants({
      manifestVersion: '0.9.0',
      versionSource:
        "/*\nexport const CORE_VERSION = '0.9.0';\n*/\nexport const CORE_VERSION = '1.0.0';\n",
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('CORE_VERSION is "1.0.0"');
  });

  it('passes on the real repository', () => {
    const { status, output } = runGuard([]);
    expect(output).toContain('no drift');
    expect(status).toBe(0);
  });
});
