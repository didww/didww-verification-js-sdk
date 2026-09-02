// Negative controls for the criterion (b) gate. Each fixture is a React
// Native-shaped package whose built entry reaches a Node builtin one way or
// another; the guard must fail and name the importing file.
//
// The real React Native package has no build yet, so today its assertion is
// that the guard reports the missing bundle rather than passing. It flips to a
// clean pass once that package builds, and fails either way if a builtin ever
// becomes reachable.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'scripts', 'check-no-node-builtins.mjs');
const FIXTURES = path.join(ROOT, 'scripts', '__fixtures__', 'no-node-builtins');

const staged = [];

afterAll(() => {
  for (const dir of staged) fs.rmSync(dir, { recursive: true, force: true });
});

// `vendor/` becomes `node_modules/` in the temp copy: the fixture must resolve
// its core through real node resolution, and a committed `node_modules/` is
// gitignored.
function stageFixture(name) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `fx-builtins-${name}-`)));
  staged.push(dir);
  fs.cpSync(path.join(FIXTURES, name), dir, { recursive: true });
  const vendor = path.join(dir, 'vendor');
  if (fs.existsSync(vendor)) {
    fs.cpSync(vendor, path.join(dir, 'node_modules'), { recursive: true });
    fs.rmSync(vendor, { recursive: true, force: true });
  }
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

const runFixture = (name) => runGuard(['--root', stageFixture(name), '--package-dir', '.']);

describe('check-no-node-builtins', () => {
  it('passes when nothing in the graph touches a builtin', () => {
    const { status, output } = runFixture('clean');
    expect(output).toContain('criterion (b) holds');
    expect(output).toContain('@didww/verification-core was traversed');
    expect(status).toBe(0);
  });

  it('names the importer of a node:-prefixed builtin', () => {
    const { status, output } = runFixture('node-prefixed');
    expect(status).toBe(1);
    expect(output).toContain('node:crypto  <-  out/index.js');
  });

  it('names the importer of a bare builtin specifier', () => {
    const { status, output } = runFixture('bare-builtin');
    expect(status).toBe(1);
    expect(output).toContain('crypto  <-  out/index.js');
    expect(output).not.toContain('node:crypto');
  });

  it('names the transitive importer when only core reaches the builtin', () => {
    const { status, output } = runFixture('transitive');
    expect(status).toBe(1);
    expect(output).toContain('node:crypto  <-  node_modules/@didww/verification-core/index.js');
    // The entry itself is clean; the guard must not blame it.
    expect(output).not.toContain('<-  out/index.js');
  });

  it('refuses to pass vacuously when core is externalised away', () => {
    const { status, output } = runFixture('external-misconfigured');
    expect(status).toBe(1);
    expect(output).toContain('@didww/verification-core was never traversed');
    expect(output).toContain('it is in the external list');
    // Proof the fixture is only caught by the metafile assertion: the builtin
    // inside core was never resolved, so no violation was reported.
    expect(output).not.toContain('Node builtin import(s) reachable');
  });

  // Every other fixture declares one entry, so this is the only one that exercises the
  // multi-entry path -- and the real package has two. Its `module` entry is clean and only `main`
  // reaches a builtin, so it fails if either entry goes unbundled, and it fails with "the bundle
  // could not be built" if esbuild is handed several entry points with nowhere to name them.
  it('bundles every declared entry, not just the first', () => {
    const { status, output } = runFixture('multi-entry');
    expect(status).toBe(1);
    expect(output).not.toContain('the bundle could not be built');
    expect(output).toContain('node:crypto  <-  out/commonjs/index.js');
  });

  it('fails, rather than skipping, when the declared entry was never built', () => {
    const { status, output } = runFixture('unbuilt');
    expect(status).toBe(1);
    expect(output).toContain('the built entry does not exist; run `npm run build` first');
    expect(output).toContain('this is a failure, not a skip');
  });

  it('either passes on the real package or reports it as unbuilt, never anything else', () => {
    const { status, output } = runGuard([]);
    if (status === 0) {
      expect(output).toContain('criterion (b) holds');
    } else {
      expect(output).toContain('the built entry does not exist');
      expect(output).not.toContain('reachable from the React Native bundle');
      expect(output).not.toContain('was never traversed');
    }
  });
});
