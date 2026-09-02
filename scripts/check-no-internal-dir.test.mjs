// Negative controls for the release gate. The check is a pure function over the list
// of root directory names, so no directory has to be created to exercise it.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkNoInternalDir } from './check-no-internal-dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts', 'check-no-internal-dir.mjs');

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

describe('check-no-internal-dir', () => {
  it('passes when the directory is absent', () => {
    expect(checkNoInternalDir(['docs', 'packages', 'scripts'])).toEqual([]);
  });

  it('fails when the directory is present, and names removal as the fix', () => {
    const failures = checkNoInternalDir(['docs', 'internal', 'packages', 'scripts']);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('internal/ is present at the repository root');
    expect(failures[0]).toContain('delete the directory to fix this');
    expect(failures[0]).toContain('do not add it to .gitignore');
  });

  it('does not match a directory that merely starts with the name', () => {
    expect(checkNoInternalDir(['internal-docs', 'internals'])).toEqual([]);
  });

  // This gate is expected to be red until the notes are removed, so the run against
  // the real repository asserts the verdict matches what is actually on disk.
  it('agrees with the working tree', () => {
    const present = fs.existsSync(path.join(ROOT, 'internal'));
    const { status, output } = runGuard([]);
    if (present) {
      expect(output).toContain('internal/ is present at the repository root');
      expect(output).toContain('not ready to be made public');
      expect(status).toBe(1);
    } else {
      expect(output).toContain('ready to be made public');
      expect(status).toBe(0);
    }
  });
});
