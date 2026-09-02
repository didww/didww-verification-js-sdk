#!/usr/bin/env node
// CI gate: the published manifests carry the metadata npm needs at publish time. A pure
// read of each `package.json` plus a LICENSE byte-compare, because most of what it checks
// is otherwise discovered at the moment of a release.
//
// Usage: node scripts/check-package-metadata.mjs [--root DIR]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SELF), '..');
const CORE = '@didww/verification-core';
const MIN_NODE_MAJOR = 22;
const RN = '@didww/verification-react-native';

// Per-package `engines.node`. A blanket `>=N` is right for the two Node packages and
// wrong for the React Native one: react-native enumerates supported majors rather than
// declaring a floor, so `>=22` would advertise Node 22.0-22.12 and 23.x, which
// react-native rejects -- a hard install failure under this repo's `engine-strict`,
// naming react-native rather than us. The value is react-native 0.86.2's own list minus
// the `^20.19.4` arm; matched exactly, so a bump goes red for a human to re-read.
const EXPECTED_ENGINES = {
  [CORE]: { kind: 'floor' },
  '@didww/verification-node': { kind: 'floor' },
  [RN]: { kind: 'exact', value: '^22.13.0 || ^24.3.0 || >= 25.0.0' },
};

// Per-package `files` allowlists. A blanket rule cannot express these: the two Node
// packages ship one build directory, while the React Native package must ship the
// Android sources a consumer's Gradle build compiles -- minus the trees Gradle writes
// back into them.
const EXPECTED_FILES = {
  [CORE]: { include: ['dist'], negate: [] },
  '@didww/verification-node': { include: ['dist'], negate: [] },
  '@didww/verification-react-native': {
    // Exact subpaths, not `android` plus negations: a `files` entry overrides .gitignore for
    // its whole subtree, so a blocklist ships every untracked local directory nobody thought
    // to negate — build output, local.properties, editor and tool scratch.
    include: ['lib', 'android/build.gradle', 'android/src/main', 'expo-module.config.json'],
    negate: [],
  },
};

// --- version arithmetic ------------------------------------------------------
// Hand-rolled rather than taken from `semver`, which is present in node_modules only
// as a transitive dependency and could disappear on any lockfile change.

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Caret bounds, including the 0.x rule: below 1.0.0 the minor is the breaking
// position, so `^0.1.0` means `>=0.1.0 <0.2.0`.
function caretUpperBound([major, minor, patch]) {
  if (major > 0) return [major + 1, 0, 0];
  if (minor > 0) return [0, minor + 1, 0];
  return [0, 0, patch + 1];
}

export function caretAdmits(rangeVersion, version) {
  return (
    compareVersions(version, rangeVersion) >= 0 &&
    compareVersions(version, caretUpperBound(rangeVersion)) < 0
  );
}

// --- individual checks -------------------------------------------------------

function publishAccessFailures(packages) {
  return packages
    .filter((pkg) => pkg.manifest.publishConfig?.access !== 'public')
    .map(
      (pkg) =>
        `${label(pkg)}: publishConfig.access is ${JSON.stringify(pkg.manifest.publishConfig?.access)}. ` +
        `A scoped package defaults to restricted, so the first publish fails without "public".`,
    );
}

function enginesFailures(packages) {
  const failures = [];
  for (const pkg of packages) {
    const declared = pkg.manifest.engines?.node;
    const expected = EXPECTED_ENGINES[pkg.manifest.name];

    if (!expected) {
      failures.push(
        `${label(pkg)}: no engines.node expectation is declared for this package. ` +
          `Add one to EXPECTED_ENGINES rather than letting a new package go unchecked.`,
      );
      continue;
    }

    if (expected.kind === 'exact') {
      if (declared === expected.value) continue;
      failures.push(
        `${label(pkg)}: engines.node is ${JSON.stringify(declared ?? null)}, expected ` +
          `${JSON.stringify(expected.value)} exactly — react-native's own supported majors, ` +
          `minus the Node 20 arm. Re-read react-native's manifest before changing this.`,
      );
      continue;
    }

    const match = typeof declared === 'string' ? /^>=\s*(\d+)/.exec(declared.trim()) : null;
    if (match && !declared.includes('||') && Number(match[1]) >= MIN_NODE_MAJOR) continue;
    failures.push(
      `${label(pkg)}: engines.node is ${JSON.stringify(declared ?? null)}. ` +
        `Expected a \`>=${MIN_NODE_MAJOR}\` range with no \`||\` union; a caret such as "^${MIN_NODE_MAJOR}" ` +
        `means \`<${MIN_NODE_MAJOR + 1}.0.0\` and would exclude every later Node major.`,
    );
  }
  return failures;
}

function coreRangeFailures(packages) {
  const core = packages.find((pkg) => pkg.manifest.name === CORE);
  if (!core) return [`${CORE} is not among the packages, so no dependent range can be checked.`];
  const coreVersion = parseVersion(core.manifest.version);
  if (!coreVersion) {
    return [`${CORE}: version ${JSON.stringify(core.manifest.version)} is not a plain X.Y.Z.`];
  }

  const failures = [];
  for (const pkg of packages) {
    if (pkg.manifest.name === CORE) continue;
    const range = pkg.manifest.dependencies?.[CORE] ?? pkg.manifest.peerDependencies?.[CORE];
    if (range === undefined) continue;

    if (!range.startsWith('^')) {
      failures.push(
        `${label(pkg)}: depends on ${CORE} as ${JSON.stringify(range)}, which is a pin, not a caret range. ` +
          `A pin makes every core patch a lockstep release of all three packages.`,
      );
      continue;
    }
    const wanted = parseVersion(range.slice(1));
    if (!wanted) {
      failures.push(
        `${label(pkg)}: depends on ${CORE} as ${JSON.stringify(range)}, which is not a plain \`^X.Y.Z\` caret range.`,
      );
      continue;
    }
    if (!caretAdmits(wanted, coreVersion)) {
      const [uMajor, uMinor, uPatch] = caretUpperBound(wanted);
      failures.push(
        `${label(pkg)}: ${JSON.stringify(range)} covers >=${wanted.join('.')} <${uMajor}.${uMinor}.${uPatch}, ` +
          `which does not admit ${CORE}@${core.manifest.version}. npm would install a second copy of core ` +
          `beside the first, and \`instanceof\` stops working across the boundary.`,
      );
    }
  }
  return failures;
}

function licenseFailures(packages, rootLicense) {
  const failures = [];
  for (const pkg of packages) {
    if (pkg.license === null) {
      failures.push(
        `${label(pkg)}: no LICENSE file in the package directory. npm only auto-includes a licence ` +
          `file sitting beside package.json, so the repository-root copy never reaches the tarball.`,
      );
    } else if (pkg.license !== rootLicense) {
      failures.push(
        `${label(pkg)}: LICENSE is not byte-identical to the repository-root LICENSE ` +
          `(${pkg.license.length} bytes against ${rootLicense.length}).`,
      );
    }
  }
  return failures;
}

// `!android/build`, `!android/build/` and `!android/build/**` all exclude the same tree.
function negatedPath(entry) {
  return entry
    .slice(1)
    .replace(/\/\*\*$/, '')
    .replace(/\/$/, '');
}

function filesFailures(packages) {
  const failures = [];
  for (const pkg of packages) {
    const expected = EXPECTED_FILES[pkg.manifest.name];
    if (!expected) {
      failures.push(
        `${label(pkg)}: no expected "files" allowlist is declared for this package in ${path.basename(SELF)}.`,
      );
      continue;
    }
    const files = pkg.manifest.files;
    if (!Array.isArray(files)) {
      failures.push(
        `${label(pkg)}: no "files" allowlist, so npm packs everything the ignore rules do not remove.`,
      );
      continue;
    }
    const positives = files.filter((entry) => !entry.startsWith('!')).sort();
    const wanted = [...expected.include].sort();
    if (positives.join(', ') !== wanted.join(', ')) {
      failures.push(
        `${label(pkg)}: "files" ships [${positives.join(', ')}]; expected exactly [${wanted.join(', ')}].`,
      );
    }
    const negated = new Set(files.filter((entry) => entry.startsWith('!')).map(negatedPath));
    const missing = expected.negate.filter((entry) => !negated.has(entry));
    if (missing.length > 0) {
      failures.push(
        `${label(pkg)}: "files" is missing the negation(s) ${missing.map((entry) => `!${entry}`).join(', ')}. ` +
          `Without them the tarball ships build output and test sources from inside an included directory.`,
      );
    }
  }
  return failures;
}

function iosFailures(packages) {
  const failures = [];
  for (const pkg of packages) {
    const offenders = pkg.entries.filter((entry) => entry === 'ios' || entry.endsWith('.podspec'));
    if (offenders.length > 0) {
      failures.push(
        `${label(pkg)}: ships ${offenders.join(', ')}. There is no iOS implementation; an ios/ ` +
          `directory or a podspec makes CocoaPods try to build one in every consuming app.`,
      );
    }
  }
  return failures;
}

// npm resolves a README's relative links against `repository`, and every package README
// links to its siblings that way. Without the field those links 404 on the registry page
// and the package shows no repository at all -- invisible in a checkout, where the same
// links resolve.
function repositoryFailures(packages) {
  const failures = [];
  for (const pkg of packages) {
    const { repository } = pkg.manifest;
    if (typeof repository?.url !== 'string' || repository.url === '') {
      failures.push(
        `${label(pkg)}: no repository.url. npm resolves README relative links against it, ` +
          `so every cross-package link in the README 404s on the registry page.`,
      );
      continue;
    }
    // A monorepo package needs `directory` too: without it npm resolves links against the
    // repository root rather than the package folder, so they point at the wrong tree.
    if (repository.directory !== pkg.id) {
      failures.push(
        `${label(pkg)}: repository.directory is ${JSON.stringify(repository.directory)}, ` +
          `expected ${JSON.stringify(pkg.id)}. Relative README links resolve against it.`,
      );
    }
  }
  return failures;
}

function label(pkg) {
  return pkg.manifest.name ?? pkg.id;
}

// --- pure entry point --------------------------------------------------------

// `input.packages` is `[{ id, manifest, license, entries }]`: the parsed manifest, the
// LICENSE read as latin1 so string equality is byte equality (null when absent), and
// the package directory's top-level entry names.
export function checkMetadata({ rootLicense, packages }) {
  return [
    { title: 'publishConfig.access is public', failures: publishAccessFailures(packages) },
    {
      title: `engines.node is the per-package expectation (>= ${MIN_NODE_MAJOR}; react-native mirrors its own)`,
      failures: enginesFailures(packages),
    },
    {
      title: `${CORE} is a caret range admitting its current version`,
      failures: coreRangeFailures(packages),
    },
    {
      title: 'every package carries the root LICENSE verbatim',
      failures: licenseFailures(packages, rootLicense),
    },
    {
      title: 'the "files" allowlist is exactly the per-package list',
      failures: filesFailures(packages),
    },
    { title: 'no iOS project ships in any package', failures: iosFailures(packages) },
    {
      title: 'repository.url and repository.directory are set, so README links resolve on npm',
      failures: repositoryFailures(packages),
    },
  ];
}

// --- driver ------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { root: DEFAULT_ROOT };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inlineValue] = argv[i].split(/=(.*)/s);
    const value = () => {
      if (inlineValue !== undefined) return inlineValue;
      i += 1;
      if (i >= argv.length) throw new Error(`${flag} needs a value`);
      return argv[i];
    };
    if (flag === '--root') opts.root = path.resolve(value());
    else throw new Error(`unknown argument: ${flag}`);
  }
  opts.root = fs.realpathSync(opts.root);
  return opts;
}

function readPackages(root) {
  const packagesDir = path.join(root, 'packages');
  return fs
    .readdirSync(packagesDir)
    .filter((entry) => fs.existsSync(path.join(packagesDir, entry, 'package.json')))
    .sort()
    .map((entry) => {
      const dir = path.join(packagesDir, entry);
      const licensePath = path.join(dir, 'LICENSE');
      return {
        id: `packages/${entry}`,
        manifest: JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')),
        license: fs.existsSync(licensePath) ? fs.readFileSync(licensePath, 'latin1') : null,
        entries: fs.readdirSync(dir),
      };
    });
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const rootLicensePath = path.join(opts.root, 'LICENSE');
  if (!fs.existsSync(rootLicensePath)) {
    console.error(`check-package-metadata: no LICENSE at ${rootLicensePath}`);
    return 1;
  }
  const packages = readPackages(opts.root);
  if (packages.length === 0) {
    console.error(`check-package-metadata: no packages found under ${opts.root}/packages`);
    return 1;
  }

  const results = checkMetadata({
    rootLicense: fs.readFileSync(rootLicensePath, 'latin1'),
    packages,
  });

  console.log(`check-package-metadata: ${packages.map((pkg) => label(pkg)).join(', ')}`);
  let failed = 0;
  for (const { title, failures } of results) {
    if (failures.length === 0) {
      console.log(`  PASS  ${title}`);
      continue;
    }
    failed += 1;
    console.log(`  FAIL  ${title}`);
    for (const failure of failures) console.log(`        ${failure}`);
  }

  if (failed > 0) {
    console.error(`\ncheck-package-metadata: ${failed} of ${results.length} checks failed.`);
    return 1;
  }
  console.log('\ncheck-package-metadata: every package is publishable.');
  return 0;
}

// Guarded so the checks above can be imported by the negative controls without the
// driver running.
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exitCode = main();
}
