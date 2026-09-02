#!/usr/bin/env node
// CI gate: @didww/verification-core must install with nothing behind it.
//
// Three independent checks, because each one alone has a hole:
//   1. the manifest declares no dependency key at all,
//   2. the resolved production subtree is empty,
//   3. the packed tarball installs into an empty project as exactly one package
//      -- the only check that also sees the `files` allowlist.
//
// Usage: node scripts/check-zero-deps.mjs [--root DIR] [--package NAME] [--package-dir DIR]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PACKAGE = '@didww/verification-core';
const DEFAULT_PACKAGE_DIR = 'packages/verification-core';

// A dependency key of any of these kinds puts something behind the package.
// `bundleDependencies` is included because it hides inside the tarball, where
// check 3's top-level count cannot see it.
const DEPENDENCY_KEYS = [
  'dependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundleDependencies',
  'bundledDependencies',
];

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT, package: DEFAULT_PACKAGE, packageDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inlineValue] = argv[i].split(/=(.*)/s);
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      if (i >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[i];
    };
    if (flag === '--root') opts.root = path.resolve(value());
    else if (flag === '--package') opts.package = value();
    else if (flag === '--package-dir') opts.packageDir = value();
    else throw new Error(`unknown argument: ${flag}`);
  }
  opts.root = fs.realpathSync(path.resolve(opts.root));
  opts.packageDir = path.resolve(
    opts.root,
    opts.packageDir ?? (opts.package === DEFAULT_PACKAGE ? DEFAULT_PACKAGE_DIR : ''),
  );
  return opts;
}

// Drained by the driver after each check so ordering stays readable.
const notes = [];

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function npm(args, cwd) {
  const npmCli = process.env.npm_execpath;
  const useNode = npmCli && npmCli.endsWith('.js');
  return execFileSync(useNode ? process.execPath : 'npm', useNode ? [npmCli, ...args] : args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false' },
  });
}

function npmAllowingFailure(args, cwd) {
  try {
    return { ok: true, stdout: npm(args, cwd) };
  } catch (error) {
    return { ok: false, stdout: error.stdout ?? '', stderr: error.stderr ?? String(error) };
  }
}

// --- check 1 -----------------------------------------------------------------

function checkManifestHasNoDependencyKeys(manifest) {
  const present = DEPENDENCY_KEYS.filter((key) => key in manifest);
  if (present.length === 0) return [];
  return present.map(
    (key) =>
      `manifest declares a "${key}" key. Criterion (a) requires the key to be absent, ` +
      `not empty (found: ${JSON.stringify(manifest[key])}).`,
  );
}

// --- check 2 -----------------------------------------------------------------

function findTreeNode(node, name) {
  for (const [depName, dep] of Object.entries(node.dependencies ?? {})) {
    if (depName === name) return dep;
    const nested = findTreeNode(dep, name);
    if (nested) return nested;
  }
  return null;
}

function checkResolvedSubtreeIsEmpty(opts) {
  const args = [
    'ls',
    '--omit=dev',
    '--omit=peer',
    '--omit=optional',
    '--all',
    '--json',
    '-w',
    opts.package,
  ];
  const result = npmAllowingFailure(args, opts.root);
  let tree;
  try {
    tree = JSON.parse(result.stdout);
  } catch {
    return [`\`npm ${args.join(' ')}\` produced no parseable JSON.\n${result.stderr}`];
  }

  const failures = [];
  if (Array.isArray(tree.problems) && tree.problems.length > 0) {
    failures.push(`npm ls reported problems:\n  ${tree.problems.join('\n  ')}`);
  }

  const node = findTreeNode(tree, opts.package);
  if (!node) {
    return [
      ...failures,
      `npm ls did not report ${opts.package} at all; the workspace may not be installed.`,
    ];
  }
  const resolved = Object.keys(node.dependencies ?? {});
  if (resolved.length > 0) {
    failures.push(
      `${opts.package} resolves a non-empty production subtree: ${resolved.join(', ')}.`,
    );
  }
  return failures;
}

// --- check 3 -----------------------------------------------------------------

function entryPointTargets(manifest) {
  const targets = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.startsWith('.')) {
      targets.add(path.normalize(value));
    }
  };
  for (const field of ['main', 'module', 'types', 'typings', 'react-native', 'browser']) {
    add(manifest[field]);
  }
  const walkExports = (value) => {
    if (typeof value === 'string') return add(value);
    if (value && typeof value === 'object') Object.values(value).forEach(walkExports);
  };
  walkExports(manifest.exports);
  targets.delete(path.normalize('./package.json'));
  return [...targets];
}

// Package names as npm lays them out: `@scope/name` occupies a scope directory.
function installedPackageNames(nodeModules) {
  if (!fs.existsSync(nodeModules)) return [];
  const names = [];
  for (const entry of fs.readdirSync(nodeModules)) {
    if (entry.startsWith('.')) continue;
    if (entry.startsWith('@')) {
      for (const scoped of fs.readdirSync(path.join(nodeModules, entry))) {
        if (!scoped.startsWith('.')) names.push(`${entry}/${scoped}`);
      }
    } else {
      names.push(entry);
    }
  }
  return names.sort();
}

function checkTarballInstallsAlone(opts, manifest) {
  const failures = [];
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-deps-'));
  try {
    const packResult = npmAllowingFailure(
      ['pack', '--json', '--pack-destination', scratch, '-w', opts.package],
      opts.root,
    );
    if (!packResult.ok) return [`\`npm pack\` failed:\n${packResult.stderr}`];
    const [packed] = JSON.parse(packResult.stdout);
    const tarball = path.join(scratch, packed.filename);

    failures.push(...checkTarballContents(opts, manifest, packed));

    const project = path.join(scratch, 'consumer');
    fs.mkdirSync(project);
    fs.writeFileSync(
      path.join(project, 'package.json'),
      `${JSON.stringify({ name: 'zero-deps-consumer', version: '0.0.0', private: true }, null, 2)}\n`,
    );
    const install = npmAllowingFailure(
      ['install', '--no-audit', '--no-fund', '--ignore-scripts', tarball],
      project,
    );
    if (!install.ok) return [...failures, `installing the tarball failed:\n${install.stderr}`];

    const installed = installedPackageNames(path.join(project, 'node_modules'));
    if (installed.length !== 1 || installed[0] !== opts.package) {
      failures.push(
        `installing the ${opts.package} tarball into an empty project produced ` +
          `${installed.length} package(s): ${installed.join(', ') || '(none)'}. Expected exactly ${opts.package}.`,
      );
    }
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  return failures;
}

// The `files` allowlist half of check 3: nothing extra ships, and every declared
// entry point that has been built is actually inside the tarball.
function checkTarballContents(opts, manifest, packed) {
  const failures = [];
  const shipped = new Set(packed.files.map((file) => path.normalize(file.path)));

  const forbidden = packed.files
    .map((file) => file.path)
    .filter(
      (file) => /(^|\/)(src|node_modules|__tests__)\//.test(file) || file.endsWith('.tsbuildinfo'),
    );
  if (forbidden.length > 0) {
    failures.push(`the tarball ships files the allowlist should exclude: ${forbidden.join(', ')}.`);
  }

  const unbuilt = [];
  for (const target of entryPointTargets(manifest)) {
    const relative = path.normalize(target).replace(/^\.[\\/]/, '');
    if (!fs.existsSync(path.join(opts.packageDir, relative))) {
      unbuilt.push(target);
    } else if (!shipped.has(relative)) {
      failures.push(
        `entry point ${target} exists on disk but the "files" allowlist keeps it out of the tarball.`,
      );
    }
  }
  if (unbuilt.length > 0) {
    notes.push(
      `not built, so these entry points were not checked against the tarball: ${unbuilt.join(', ')}`,
    );
  }
  return failures;
}

// --- driver ------------------------------------------------------------------

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(opts.packageDir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`check-zero-deps: no package.json at ${manifestPath}`);
    return 1;
  }
  const manifest = readJson(manifestPath);

  const checks = [
    ['no dependency keys in the manifest', () => checkManifestHasNoDependencyKeys(manifest)],
    ['empty resolved production subtree', () => checkResolvedSubtreeIsEmpty(opts)],
    ['tarball installs as exactly one package', () => checkTarballInstallsAlone(opts, manifest)],
  ];

  console.log(
    `check-zero-deps: ${opts.package} (${path.relative(opts.root, opts.packageDir) || '.'})`,
  );
  let failed = 0;
  for (const [title, run] of checks) {
    const failures = run();
    for (const note of notes.splice(0)) console.log(`  note  ${note}`);
    if (failures.length === 0) {
      console.log(`  PASS  ${title}`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${title}`);
      for (const failure of failures) {
        console.log(
          failure
            .split('\n')
            .map((line) => `        ${line}`)
            .join('\n'),
        );
      }
    }
  }

  if (failed > 0) {
    console.error(`\ncheck-zero-deps: ${failed} of ${checks.length} checks failed.`);
    return 1;
  }
  console.log('\ncheck-zero-deps: criterion (a) holds.');
  return 0;
}

process.exitCode = main();
