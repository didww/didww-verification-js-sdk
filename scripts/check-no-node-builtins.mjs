#!/usr/bin/env node
// CI gate: no Node builtin is reachable from the React Native bundle.
//
// Bundles the *built* React Native entry points with `platform: 'neutral'` and
// fails on any import of a Node builtin, in bare (`crypto`) or prefixed
// (`node:crypto`) form, naming the file that imported it.
//
// Known hole: a computed import specifier (`import(someVariable)`) cannot be
// resolved statically, so esbuild never sees it. `eslint.config.mjs` bans those
// separately.
//
// Usage: node scripts/check-no-node-builtins.mjs [--root DIR] [--package-dir DIR]
//                                                [--require-input NAME] [--external NAME,...]

import { builtinModules, createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const DEFAULT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PACKAGE_DIR = 'packages/verification-react-native';
const DEFAULT_REQUIRE_INPUT = '@didww/verification-core';

const BARE_BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/, '')));

function isBuiltin(specifier) {
  // Any `node:` specifier is a builtin, including ones this Node release has
  // never heard of.
  if (specifier.startsWith('node:')) return true;
  return BARE_BUILTINS.has(specifier.split('/')[0]);
}

function parseArgs(argv) {
  const opts = {
    root: DEFAULT_ROOT,
    packageDir: null,
    requireInput: DEFAULT_REQUIRE_INPUT,
    external: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inlineValue] = argv[i].split(/=(.*)/s);
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      if (i >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[i];
    };
    if (flag === '--root') opts.root = value();
    else if (flag === '--package-dir') opts.packageDir = value();
    else if (flag === '--require-input') opts.requireInput = value();
    else if (flag === '--external') opts.external.push(...value().split(',').filter(Boolean));
    else throw new Error(`unknown argument: ${flag}`);
  }
  opts.root = fs.realpathSync(path.resolve(opts.root));
  opts.packageDir = path.resolve(opts.root, opts.packageDir ?? DEFAULT_PACKAGE_DIR);
  return opts;
}

// Everything a React Native host resolves as a runtime entry: Metro reads
// `react-native`/`module`/`main` and the `exports` map.
function entryTargets(manifest) {
  const targets = new Set();
  const add = (value) => {
    if (typeof value === 'string' && value.startsWith('.') && !value.endsWith('.json')) {
      if (!/\.d\.[cm]?ts$/.test(value)) targets.add(path.normalize(value));
    }
  };
  for (const field of ['react-native', 'module', 'main']) add(manifest[field]);
  const walkExports = (value, condition) => {
    if (typeof value === 'string') {
      if (condition !== 'types') add(value);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, nested] of Object.entries(value)) walkExports(nested, key);
    }
  };
  walkExports(manifest.exports);
  return [...targets];
}

// Host-provided packages are not part of this package's own graph, and
// `react-native`'s published source is Flow-typed and will not parse here.
function externalsFor(manifest, extra) {
  const hostProvided = [
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
    ...extra,
  ];
  return [...new Set(hostProvided.flatMap((name) => [name, `${name}/*`]))];
}

function resolvePackageRoot(fromDir, name) {
  try {
    const require = createRequire(path.join(fromDir, 'package.json'));
    return fs.realpathSync(path.dirname(require.resolve(`${name}/package.json`)));
  } catch {
    return null;
  }
}

function traversed(metafile, root, packageRoot, name) {
  return Object.keys(metafile.inputs).some((input) => {
    if (input.includes(`node_modules/${name}/`)) return true;
    if (!packageRoot) return false;
    let absolute;
    try {
      absolute = fs.realpathSync(path.resolve(root, input));
    } catch {
      return false;
    }
    const relative = path.relative(packageRoot, absolute);
    return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
  });
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const manifestPath = path.join(opts.packageDir, 'package.json');
  if (!fs.existsSync(manifestPath)) {
    console.error(`check-no-node-builtins: no package.json at ${manifestPath}`);
    return 1;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const label = path.relative(opts.root, opts.packageDir) || '.';
  console.log(`check-no-node-builtins: ${manifest.name} (${label})`);

  const targets = entryTargets(manifest);
  const missing = targets.filter(
    (target) => !fs.existsSync(path.join(opts.packageDir, target.replace(/^\.[\\/]/, ''))),
  );
  if (targets.length === 0 || missing.length > 0) {
    console.error(
      `\ncheck-no-node-builtins: the built entry does not exist; run \`npm run build\` first.\n` +
        `  expected, relative to ${label}: ${(missing.length > 0 ? missing : ['(no entry point declared in package.json)']).join(', ')}\n` +
        `  criterion (b) cannot be verified without a built bundle, so this is a failure, not a skip.`,
    );
    return 1;
  }

  const external = externalsFor(manifest, opts.external);
  const violations = [];
  const guard = {
    name: 'no-node-builtins',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (!isBuiltin(args.path)) return null;
        const importer = args.importer ? path.relative(opts.root, args.importer) : '(entry point)';
        violations.push({ specifier: args.path, importer });
        return {
          errors: [
            {
              text: `Node builtin "${args.path}" is reachable from the React Native bundle, imported by ${importer}`,
            },
          ],
        };
      });
    },
  };

  let result;
  try {
    result = await esbuild.build({
      absWorkingDir: opts.root,
      entryPoints: targets.map((target) => path.join(opts.packageDir, target)),
      bundle: true,
      write: false,
      metafile: true,
      // esbuild refuses more than one entry point without it, and this package declares two --
      // Metro reads `module` and `main` and both must be checked. `write: false` above means
      // nothing is emitted; this only names the virtual outputs.
      outdir: path.join(opts.root, 'node_modules', '.cache', 'check-no-node-builtins'),
      platform: 'neutral',
      format: 'esm',
      mainFields: ['react-native', 'module', 'main'],
      conditions: ['react-native'],
      external,
      plugins: [guard],
      logLevel: 'silent',
    });
  } catch (error) {
    if (violations.length === 0) {
      console.error(`\ncheck-no-node-builtins: the bundle could not be built.\n${error.message}`);
      return 1;
    }
    console.error(
      `\ncheck-no-node-builtins: ${violations.length} Node builtin import(s) reachable:`,
    );
    for (const { specifier, importer } of violations) {
      console.error(`  ${specifier}  <-  ${importer}`);
    }
    return 1;
  }

  const packageRoot = resolvePackageRoot(opts.packageDir, opts.requireInput);
  if (!traversed(result.metafile, opts.root, packageRoot, opts.requireInput)) {
    console.error(
      `\ncheck-no-node-builtins: ${opts.requireInput} was never traversed, so this run proves nothing.\n` +
        `  bundled inputs: ${Object.keys(result.metafile.inputs).join(', ')}\n` +
        (external.some(
          (pattern) => pattern === opts.requireInput || pattern === `${opts.requireInput}/*`,
        )
          ? `  it is in the external list (${external.join(', ')}), which is why it was not read.\n`
          : `  external list: ${external.join(', ') || '(empty)'}\n`),
    );
    return 1;
  }

  console.log(
    `  PASS  ${Object.keys(result.metafile.inputs).length} module(s) bundled, no Node builtin reachable`,
  );
  console.log(`  PASS  ${opts.requireInput} was traversed`);
  console.log('\ncheck-no-node-builtins: criterion (b) holds.');
  return 0;
}

process.exitCode = await main();
