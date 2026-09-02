#!/usr/bin/env node
// Release gate: the repository root must not contain an `internal/` directory, which
// holds release-readiness notes that are not for a public audience. It is wired into
// the GitHub workflow only, so pushing this repository to GitHub turns CI red for as
// long as the directory is still there.
//
// Usage: node scripts/check-no-internal-dir.mjs [--root DIR]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SELF), '..');
const FORBIDDEN = 'internal';

// `directoryNames` is the list of directories at the repository root.
export function checkNoInternalDir(directoryNames) {
  if (!directoryNames.includes(FORBIDDEN)) return [];
  return [
    `${FORBIDDEN}/ is present at the repository root. It holds release-readiness notes that must ` +
      `not reach the public repository; delete the directory to fix this, do not add it to ` +
      `.gitignore -- an ignored directory is invisible to this gate but still sits in the working tree.`,
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

function rootDirectories(root) {
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const failures = checkNoInternalDir(rootDirectories(opts.root));

  console.log(`check-no-internal-dir: ${opts.root}`);
  if (failures.length > 0) {
    console.log(`  FAIL  no ${FORBIDDEN}/ directory at the repository root`);
    for (const failure of failures) console.log(`        ${failure}`);
    console.error(`\ncheck-no-internal-dir: the repository is not ready to be made public.`);
    return 1;
  }
  console.log(`  PASS  no ${FORBIDDEN}/ directory at the repository root`);
  console.log('\ncheck-no-internal-dir: the repository is ready to be made public.');
  return 0;
}

// Guarded so checkNoInternalDir can be imported by the negative controls without the
// driver running.
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exitCode = main();
}
