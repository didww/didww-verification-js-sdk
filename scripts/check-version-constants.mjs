#!/usr/bin/env node
// CI gate: `@didww/verification-core`'s hand-kept `src/version.ts` constant matches its own
// `package.json` `version`. The constant exists because a published package cannot rely on
// resolving its own `package.json` at runtime in every bundler it ships under (a browser bundle
// in particular, and Metro in a React Native app); this is what stops the two from drifting apart
// instead. It also backs the default `X-User-Agent` header every request carries.
//
// Usage: node scripts/check-version-constants.mjs [--root DIR]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SELF), '..');
const CONSTANT = 'CORE_VERSION';

// `input` is `{ manifestVersion, versionSource }`: the parsed `package.json` version, and the raw
// text of `src/version.ts`.
export function checkVersionConstants({ manifestVersion, versionSource }) {
  // Comments are stripped first, so a commented-out declaration never matches.
  const code = versionSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const match = new RegExp(`^export const ${CONSTANT} = '([^']*)';$`, 'm').exec(code);
  if (match === null) {
    return [`src/version.ts does not export \`const ${CONSTANT} = '<version>'\`.`];
  }
  const [, constantVersion] = match;
  if (constantVersion !== manifestVersion) {
    return [
      `version.ts's ${CONSTANT} is ${JSON.stringify(constantVersion)}, but package.json's ` +
        `version is ${JSON.stringify(manifestVersion)}.`,
    ];
  }
  return [];
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

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const dir = path.join(opts.root, 'packages', 'verification-core');
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const versionSource = fs.readFileSync(path.join(dir, 'src', 'version.ts'), 'utf8');
  const failures = checkVersionConstants({ manifestVersion: manifest.version, versionSource });

  console.log('check-version-constants: packages/verification-core');
  if (failures.length > 0) {
    console.log(`  FAIL  ${CONSTANT} matches package.json's version`);
    for (const failure of failures) console.log(`        ${failure}`);
    console.error('\ncheck-version-constants: the constant has drifted.');
    return 1;
  }
  console.log(`  PASS  ${CONSTANT} matches package.json's version`);
  console.log('\ncheck-version-constants: no drift.');
  return 0;
}

// Guarded so checkVersionConstants can be imported by the negative controls without the driver
// running.
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  process.exitCode = main();
}
