#!/usr/bin/env node
// CI gate: nothing internal leaks into this public repository.
//
// Rules are split by kind. SHAPE rules live here, because the shape of a tracker key or a
// task key gives nothing away and they must keep working once internal/ is gone. VALUE
// rules -- where the pattern IS the private string -- live in internal/, because writing
// them here would publish the very names they exist to catch.
//
// Usage: node scripts/check-no-internal-refs.mjs [--root DIR]

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
const DEFAULT_ROOT = path.resolve(path.dirname(SELF), '..');

// Standards, licence identifiers and platform API levels share a tracker key's shape.
// Allowlisted by the letters before the dash; adding a real project key here would
// switch the check off for that project, so keep this list to published vocabularies.
const TICKET_PREFIX_ALLOWLIST = new Set([
  'API', // Android API-24
  'BCP', // BCP-47 language tags
  'BSD',
  'BY', // CC-BY-4.0
  'CC',
  'ES', // ES-2022
  'GPL',
  'ISO', // ISO-8601
  'LICENSE', // the Apache LICENSE-2.0 URL in the Gradle wrapper
  'MIT',
  'MPL',
  'RFC',
  'SHA', // SHA-256
  'UTF', // UTF-8
]);

// The SDK's own sandbox is a documented, public product endpoint, so the word alone
// cannot be the signal; only a host that is neither of these is treated as internal.
const PUBLIC_HOSTS = new Set(['verification.didww.com', 'verification-sandbox.didww.com']);

function hostOf(url) {
  return url
    .replace(/^https?:\/\//i, '')
    .split(/[:/?#]/)[0]
    .toLowerCase();
}

const RULES = [
  {
    name: 'tracker key',
    pattern: /\b[A-Z]{2,}-\d+\b/g,
    allowed: (token) => TICKET_PREFIX_ALLOWLIST.has(token.split('-')[0]),
    hint: 'an issue-tracker key names work item history that is not public',
  },
  {
    // A task key or phase number resolves only against an implementation plan that is
    // not in this repository, so it reads as a dangling reference to a public reader.
    name: 'plan reference',
    pattern: /\bT\d+\.\d+\b|\bPhase \d+\b/g,
    hint: 'points at a task in a plan document that is not public; name the thing instead',
  },
  {
    name: 'non-public environment URL',
    pattern: /https?:\/\/[A-Za-z0-9._~:-]+/g,
    allowed: (token) => {
      const host = hostOf(token);
      if (PUBLIC_HOSTS.has(host)) return true;
      return !/(^|[.-])(staging|sandbox|internal)([.-]|$)/.test(host);
    },
    hint: 'points at an environment a reader of this repository cannot reach',
  },
];

function positionOf(content, index) {
  const before = content.slice(0, index);
  const line = before.split('\n').length;
  return { line, column: index - (before.lastIndexOf('\n') + 1) + 1 };
}

// Value-based rules -- ones whose pattern IS the string it hunts for -- cannot live in a
// file that will be public, so they are loaded from internal/ when it is still present.
// Returns [] when it is not, which is why the driver prints which mode it ran in: a pass
// without them is a weaker statement, and a silent weakening is the failure this whole
// gate exists to prevent.
export function loadPrivateRules(root) {
  const file = path.join(root, 'internal', 'internal-refs-patterns.json');
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    // A malformed file must not read as "no private rules".
    throw new Error(`${file} is present but unreadable: ${error.message}`, { cause: error });
  }
  return parsed.rules.map((rule) => ({
    name: rule.name,
    pattern: new RegExp(rule.pattern, rule.flags ?? 'g'),
    hint: rule.hint,
  }));
}

// `files` is `[{ path, content }]`; returns one finding per match.
export function scanFiles(files, extraRules = []) {
  const findings = [];
  for (const file of files) {
    for (const rule of [...RULES, ...extraRules]) {
      // A shared regex carries `lastIndex` between files, so take a fresh one.
      const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
      for (const match of file.content.matchAll(pattern)) {
        if (rule.allowed?.(match[0])) continue;
        findings.push({
          path: file.path,
          ...positionOf(file.content, match.index),
          rule: rule.name,
          token: match[0],
          hint: rule.hint,
        });
      }
    }
  }
  return findings;
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

// Tracked files plus untracked ones git would not ignore. Asking git rather than
// listing build directories by hand means a new one cannot silently widen the blind
// spot, and a file staged but not yet committed is still scanned.
function candidatePaths(root) {
  let listed;
  try {
    listed = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Failing loudly beats scanning nothing: an empty list would report a clean repository.
    throw new Error(
      `this check enumerates files with git, and ${root} is not a git working tree. ` +
        `Run it inside a checkout.`,
      { cause: error },
    );
  }
  return [...new Set(listed.split('\0').filter(Boolean))].sort();
}

function readTextFiles(root, paths) {
  const files = [];
  let binary = 0;
  for (const relative of paths) {
    let buffer;
    try {
      buffer = fs.readFileSync(path.join(root, relative));
    } catch {
      continue; // a broken symlink or a race with another tool
    }
    if (buffer.includes(0)) {
      binary += 1;
      continue;
    }
    files.push({ path: relative, content: buffer.toString('utf8') });
  }
  return { files, binary };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  // `internal/` is the one directory allowed to hold these references, which is exactly
  // why check-no-internal-dir.mjs exists: skipping it here would be a hole without a
  // separate gate that refuses to let the directory reach GitHub at all.
  const all = candidatePaths(opts.root);
  const scannable = all.filter((relative) => !relative.startsWith('internal/'));
  const skippedInternal = all.length - scannable.length;

  const { files, binary } = readTextFiles(opts.root, scannable);
  const privateRules = loadPrivateRules(opts.root);
  const findings = scanFiles(files, privateRules);

  console.log(`check-no-internal-refs: ${files.length} file(s) scanned`);
  if (skippedInternal > 0) {
    console.log(`  note  ${skippedInternal} file(s) under internal/ skipped by design`);
  }
  if (binary > 0) console.log(`  note  ${binary} binary file(s) skipped`);
  console.log(
    privateRules.length > 0
      ? `  note  ${privateRules.length} private rule(s) loaded from internal/`
      : `  note  internal/ is absent, so ${RULES.length} shape rule(s) ran and the private ` +
          `value rules did not. Run this from a checkout that still has internal/ before pushing.`,
  );

  if (findings.length > 0) {
    console.log(`  FAIL  no internal reference appears in a public file`);
    for (const finding of findings) {
      console.log(
        `        ${finding.path}:${finding.line}:${finding.column}  ${finding.token}  ` +
          `(${finding.rule}: ${finding.hint})`,
      );
    }
    console.error(`\ncheck-no-internal-refs: ${findings.length} internal reference(s) found.`);
    return 1;
  }

  console.log(`  PASS  no internal reference appears in a public file`);
  console.log('\ncheck-no-internal-refs: the repository is clean.');
  return 0;
}

// Guarded so scanFiles can be imported by the negative controls without the driver
// running.
if (process.argv[1] && path.resolve(process.argv[1]) === SELF) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`\ncheck-no-internal-refs: ${error.message}`);
    process.exitCode = 1;
  }
}
