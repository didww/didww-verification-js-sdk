// The published tarball must carry `android/` and `expo-module.config.json`, or a consumer's
// Android build autolinks nothing: the native module is never compiled in, the lookup answers
// `null`, and SMS auto-capture is silently dead for every consumer. Nothing else fails.
//
// Asserting it inside the workspace is a false pass: autolinking follows the workspace symlink and
// reads the source directory, where `android/` and the config always sit, whichever of them
// `package.json` `files` actually ships. Measured -- with `files` cut to `["lib"]` the tarball
// carries neither and autolinking through the symlink still reports the module. So the tarball is
// installed into a scratch project outside the workspace and resolved there.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE = '@didww/verification-react-native';
const CORE = '@didww/verification-core';
const MODULE_CLASS = 'com.didww.verification.rn.DidwwVerificationSmsModule';

// The workspace's own copy, which is the one `npx expo-modules-autolinking` would run; installing a
// second copy into the scratch project would only cost a registry round trip. Discovery is anchored
// by `--project-root`, not by where the CLI lives -- control 1 is what proves that.
const AUTOLINKING = path.join(
  path.dirname(createRequire(import.meta.url).resolve('expo-modules-autolinking/package.json')),
  'bin',
  'expo-modules-autolinking.js',
);

const IOS_ENTRY = /(^|\/)ios\/|\.podspec$/;

// `android/` in `files` sweeps in the Gradle output next to the sources, which no other check in
// this repository looks at; `android/build.gradle` is a sibling of that directory, not part of it,
// so this may only match on a whole path segment.
const NOT_SHIPPABLE = /^android\/(build|\.gradle)\/|^android\/src\/(test|androidTest)\/|\.iml$/;

/** The packed entries that would ship an iOS surface. */
function iosEntries(files) {
  return files.filter((file) => IOS_ENTRY.test(file));
}

/** The packed entries that are Gradle intermediates or Android unit tests. */
function unshippableEntries(files) {
  return files.filter((file) => NOT_SHIPPABLE.test(file));
}

let scratch;
let consumer;
let control;
let packedFiles;

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

function resolveModules(projectRoot) {
  const output = execFileSync(
    process.execPath,
    [AUTOLINKING, 'resolve', '-p', 'android', '--json', '--project-root', projectRoot],
    { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  );
  return JSON.parse(output).modules;
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'expo-autolinking-')));

  // Core is packed too because it is a real dependency, and an unpublished one -- installing this
  // package's tarball alone would send npm to the registry for it.
  const packed = JSON.parse(
    npm(['pack', '--json', '--pack-destination', scratch, '-w', CORE, '-w', PACKAGE], ROOT),
  );
  const tarballs = Object.fromEntries(packed.map((p) => [p.name, path.join(scratch, p.filename)]));
  packedFiles = packed.find((p) => p.name === PACKAGE).files.map((file) => file.path);

  consumer = path.join(scratch, 'consumer');
  fs.mkdirSync(consumer);
  writeJson(path.join(consumer, 'package.json'), {
    name: 'expo-autolinking-consumer',
    version: '0.0.0',
    private: true,
  });
  // `--legacy-peer-deps` skips this package's peers: react-native is a large install and
  // autolinking reads the package directory, never the peer tree.
  npm(
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      '--legacy-peer-deps',
      tarballs[CORE],
      tarballs[PACKAGE],
    ],
    consumer,
  );

  control = path.join(scratch, 'control');
  fs.cpSync(consumer, control, { recursive: true });
  fs.rmSync(path.join(control, 'node_modules', PACKAGE, 'expo-module.config.json'));
}, 170_000);

afterAll(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

describe('the packed @didww/verification-react-native', () => {
  it('is autolinked as an Android module once installed from the tarball', () => {
    const linked = resolveModules(consumer).find((module) => module.packageName === PACKAGE);

    expect(linked).toBeDefined();
    expect(linked.projects.flatMap((p) => p.modules.map((m) => m.classifier))).toEqual([
      MODULE_CLASS,
    ]);
  });

  it('ships the two files autolinking reads', () => {
    expect(packedFiles).toContain('expo-module.config.json');
    expect(packedFiles.filter((file) => file.startsWith('android/'))).toContain(
      'android/src/main/java/com/didww/verification/rn/DidwwVerificationSmsModule.kt',
    );
    expect(packedFiles).toContain('android/build.gradle');
  });

  it('ships no iOS directory and no podspec', () => {
    expect(iosEntries(packedFiles)).toEqual([]);
    expect(packedFiles.length).toBeGreaterThan(0);
  });

  it('ships no Gradle output and no Android unit test', () => {
    expect(unshippableEntries(packedFiles)).toEqual([]);
    expect(packedFiles).toContain('android/build.gradle');
  });

  // Control 1: the resolution must turn empty once the config is gone, or the assertion above is
  // satisfied by an installed package that ships nothing autolinking can read.
  it('would not be autolinked without expo-module.config.json', () => {
    const packageNames = resolveModules(control).map((module) => module.packageName);

    expect(packageNames).not.toContain(PACKAGE);
    expect(packageNames).toEqual([]);
  });

  // Control 2: the iOS predicate names what it finds, rather than accepting every list.
  it('would report an iOS directory and a podspec in a packed file list', () => {
    expect(
      iosEntries([
        'package.json',
        'android/build.gradle',
        'ios/DidwwVerificationSms.swift',
        'DidwwVerificationSms.podspec',
      ]),
    ).toEqual(['ios/DidwwVerificationSms.swift', 'DidwwVerificationSms.podspec']);
  });

  // Control 3: the Gradle-output predicate catches the directory without catching its sibling.
  it('would report Gradle output and unit tests, but not android/build.gradle', () => {
    expect(
      unshippableEntries([
        'android/build.gradle',
        'android/src/main/AndroidManifest.xml',
        'android/build/generated/autolinking/autolinking.json',
        'android/.gradle/8.0/fileHashes.bin',
        'android/src/test/java/ModuleTest.kt',
        'android/src/androidTest/java/AppHashDeviceTest.kt',
        'android/verification.iml',
      ]),
    ).toEqual([
      'android/build/generated/autolinking/autolinking.json',
      'android/.gradle/8.0/fileHashes.bin',
      'android/src/test/java/ModuleTest.kt',
      'android/src/androidTest/java/AppHashDeviceTest.kt',
      'android/verification.iml',
    ]);
  });
});
