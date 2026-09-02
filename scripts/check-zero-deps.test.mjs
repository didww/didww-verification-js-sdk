// Negative controls for the criterion (a) gate. Each fixture is a deliberately
// broken workspace; the guard must fail on it and name what is wrong. The clean
// fixture proves the harness is not rigged to fail.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts', 'check-zero-deps.mjs');
const FIXTURES = path.join(ROOT, 'scripts', '__fixtures__', 'zero-deps');

const staged = [];

afterAll(() => {
  for (const dir of staged) fs.rmSync(dir, { recursive: true, force: true });
});

// Fixtures run from a temp copy: `npm install` writes a lockfile and a
// node_modules, and an ancestor node_modules would change what npm resolves.
function stageFixture(name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `fx-zero-deps-${name}-`)));
  staged.push(dir);
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  execFileSync('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts'], {
    cwd: dir,
    stdio: 'ignore',
  });
  return dir;
}

function runGuard(args) {
  try {
    const stdout = execFileSync(process.execPath, [GUARD, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output: stdout };
  } catch (error) {
    return { status: error.status ?? 1, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const runFixture = (name) => runGuard(['--root', stageFixture(name)]);

describe('check-zero-deps', () => {
  it('passes on a core package with no dependency keys and a whole tarball', () => {
    const { status, output } = runFixture('clean');
    expect(output).toContain('criterion (a) holds');
    expect(status).toBe(0);
  });

  it('rejects an empty "dependencies" object, which is a key and not an absence', () => {
    const { status, output } = runFixture('deps-key-present');
    expect(status).toBe(1);
    expect(output).toContain('manifest declares a "dependencies" key');
    expect(output).toContain('requires the key to be absent');
    // The other two checks still pass, so this fixture isolates check 1.
    expect(output).toContain('PASS  empty resolved production subtree');
    expect(output).toContain('PASS  tarball installs as exactly one package');
  });

  it('names the dependency that a real production subtree pulls in', () => {
    const { status, output } = runFixture('transitive-dep');
    expect(status).toBe(1);
    expect(output).toContain('resolves a non-empty production subtree: fixture-leaf');
    expect(output).toContain('produced 2 package(s): @didww/verification-core, fixture-leaf');
  });

  it('names an entry point that the "files" allowlist keeps out of the tarball', () => {
    const { status, output } = runFixture('files-drops-entry');
    expect(status).toBe(1);
    expect(output).toContain(
      'entry point out/index.js exists on disk but the "files" allowlist keeps it out',
    );
    expect(output).toContain('PASS  no dependency keys in the manifest');
    expect(output).toContain('PASS  empty resolved production subtree');
  });

  it('passes on the real workspace', () => {
    const { status, output } = runGuard([]);
    expect(output).toContain('criterion (a) holds');
    expect(status).toBe(0);
  });
});
