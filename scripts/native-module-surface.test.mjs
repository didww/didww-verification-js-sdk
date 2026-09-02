// The React Native code resolves the Android module by a string name, then calls three methods and
// subscribes to one event on it. Kotlin declares all of those names independently and nothing
// compares the two halves. A mismatch fails no build: the lookup answers `null`, the SDK degrades
// to manual entry, and SMS auto-capture is dead on every device. The package's own tests mock the
// native module, so they prove only that the two JavaScript halves agree with each other.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = path.join(ROOT, 'packages', 'verification-react-native');

const NATIVE_TS = path.join('src', 'sms', 'native.ts');
const CONFIG = 'expo-module.config.json';
const KOTLIN_SOURCE_ROOT = path.join('android', 'src', 'main', 'java');
const KOTLIN = path.join(
  KOTLIN_SOURCE_ROOT,
  'com',
  'didww',
  'verification',
  'rn',
  'DidwwVerificationSmsModule.kt',
);

const DECLARED_CLASS = 'com.didww.verification.rn.DidwwVerificationSmsModule';

// `addListener` comes from Expo's module wrapper, not from our `ModuleDefinition`, so it is not a
// name the two sides can disagree on. `Events(...)` likewise makes Expo add `startObserving` and
// `stopObserving` at runtime; they are absent from the Kotlin source this file parses, and adding
// them here would make the comparison fail against correct code.
const PROVIDED_BY_EXPO = new Set(['addListener']);

function captures(source, pattern) {
  return [...source.matchAll(pattern)].map(([, value]) => value);
}

function javascriptSurface(source) {
  const body = source.match(/interface\s+NativeSmsModule\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
  return {
    moduleName: source.match(/const\s+NATIVE_MODULE_NAME\s*=\s*['"]([^'"]+)['"]/)?.[1] ?? null,
    methods: captures(body, /^\s*([A-Za-z_$][\w$]*)\s*\(/gm).filter(
      (name) => !PROVIDED_BY_EXPO.has(name),
    ),
    // The literal on `addListener`'s `event` parameter. listener.ts's actual subscription is
    // typechecked against it, so the two cannot drift and parsing this one place covers both.
    events: captures(source, /addListener\(\s*event:\s*['"]([^'"]+)['"]/g),
  };
}

function kotlinSurface(source) {
  const eventArgs = source.match(/\bEvents\(([^)]*)\)/)?.[1] ?? '';
  return {
    packageName: source.match(/^package\s+([\w.]+)/m)?.[1] ?? null,
    className: source.match(/^\s*class\s+(\w+)\s*:\s*Module\s*\(/m)?.[1] ?? null,
    moduleName: source.match(/\bName\(\s*"([^"]+)"/)?.[1] ?? null,
    functions: captures(source, /\b(?:Async)?Function\(\s*"([^"]+)"/g),
    events: captures(eventArgs, /"([^"]*)"/g),
  };
}

function sorted(values) {
  return [...values].sort();
}

/** Every disagreement between the three sources, as one list of human-readable strings. */
function surfaceProblems(sources) {
  const problems = [];
  const js = javascriptSurface(sources.nativeTs);
  const kotlin = kotlinSurface(sources.kotlin);
  const config = JSON.parse(sources.config);
  const declared = config.android?.modules ?? [];
  const platforms = config.platforms ?? [];

  // An extraction that finds nothing would make every comparison below pass vacuously.
  if (js.moduleName === null) problems.push('extracted no NATIVE_MODULE_NAME from native.ts');
  if (js.methods.length === 0)
    problems.push('extracted no method from the NativeSmsModule interface');
  if (js.events.length === 0) problems.push('extracted no event name from native.ts');
  if (kotlin.moduleName === null) problems.push('extracted no Name(...) from the Kotlin module');
  if (kotlin.functions.length === 0)
    problems.push('extracted no Function(...) from the Kotlin module');
  if (kotlin.events.length === 0) problems.push('extracted no Events(...) from the Kotlin module');
  if (kotlin.packageName === null || kotlin.className === null) {
    problems.push('extracted no package or class name from the Kotlin module');
  }
  if (declared.length === 0) problems.push('expo-module.config.json declares no android module');
  if (problems.length > 0) return problems;

  if (js.moduleName !== kotlin.moduleName) {
    problems.push(
      `module name: JavaScript looks up "${js.moduleName}", Kotlin registers "${kotlin.moduleName}"`,
    );
  }
  for (const method of js.methods) {
    if (!kotlin.functions.includes(method)) {
      problems.push(`JavaScript calls "${method}", which the Kotlin module does not declare`);
    }
  }
  for (const fn of kotlin.functions) {
    if (!js.methods.includes(fn)) {
      problems.push(`Kotlin declares "${fn}", which the JavaScript interface does not name`);
    }
  }
  if (sorted(js.events).join() !== sorted(kotlin.events).join()) {
    problems.push(
      `events: JavaScript subscribes to [${sorted(js.events)}], Kotlin declares [${sorted(kotlin.events)}]`,
    );
  }

  // A stray platform would send Expo looking for an iOS module that this package does not have.
  if (platforms.join() !== 'android') {
    problems.push(
      `expo-module.config.json declares platforms [${platforms}], the package ships Android only`,
    );
  }

  const kotlinClass = `${kotlin.packageName}.${kotlin.className}`;
  if (declared.length !== 1) {
    problems.push(
      `expo-module.config.json declares ${declared.length} android modules [${declared}], the package has one`,
    );
  } else if (declared[0] !== kotlinClass) {
    problems.push(
      `expo-module.config.json declares [${declared}], the Kotlin source is "${kotlinClass}"`,
    );
  }
  for (const name of declared) {
    const implied = path.join(KOTLIN_SOURCE_ROOT, `${name.split('.').join(path.sep)}.kt`);
    if (!sources.exists(implied)) {
      problems.push(`expo-module.config.json declares "${name}" but ${implied} does not exist`);
    }
  }
  return problems;
}

function readSources(dir) {
  return {
    nativeTs: fs.readFileSync(path.join(dir, NATIVE_TS), 'utf8'),
    kotlin: fs.readFileSync(path.join(dir, KOTLIN), 'utf8'),
    config: fs.readFileSync(path.join(dir, CONFIG), 'utf8'),
    exists: (relative) => fs.existsSync(path.join(dir, relative)),
  };
}

let scratch;
let sources;

beforeAll(() => {
  scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'native-module-surface-')));
  sources = readSources(PACKAGE_DIR);
});

afterAll(() => {
  if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
});

/** The three real sources copied into a scratch tree, with `mutate` applied to each file's text. */
function stage(name, mutate) {
  const dir = path.join(scratch, name);
  let mutated = false;
  for (const file of [NATIVE_TS, KOTLIN, CONFIG]) {
    const original = fs.readFileSync(path.join(PACKAGE_DIR, file), 'utf8');
    const text = mutate(file, original);
    mutated ||= text !== original;
    const target = path.join(dir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
  // A mutation that no longer matches -- because the source it targets was reworded -- would leave
  // the control asserting against pristine files, i.e. asserting nothing.
  if (!mutated) throw new Error(`control "${name}" changed no source`);
  return readSources(dir);
}

describe('the Android native module surface', () => {
  it('extracts names from both sides, so the comparison is not vacuous', () => {
    expect(javascriptSurface(sources.nativeTs)).toEqual({
      moduleName: 'DidwwVerificationSms',
      methods: ['getAppHash', 'startRetriever', 'stopRetriever'],
      events: ['onSmsReceived'],
    });
    expect(kotlinSurface(sources.kotlin)).toEqual({
      packageName: 'com.didww.verification.rn',
      className: 'DidwwVerificationSmsModule',
      moduleName: 'DidwwVerificationSms',
      functions: ['getAppHash', 'startRetriever', 'stopRetriever'],
      events: ['onSmsReceived'],
    });
  });

  it('is named, called and declared identically by JavaScript, Kotlin and the module config', () => {
    expect(surfaceProblems(sources)).toEqual([]);
  });

  it('is the one class the autolinking config points at, on Android alone', () => {
    expect(JSON.parse(sources.config)).toMatchObject({
      platforms: ['android'],
      android: { modules: [DECLARED_CLASS] },
    });
  });

  // Control 1: a renamed Kotlin module is what the runtime lookup would miss, silently.
  it('would report a Kotlin module registered under another name', () => {
    const control = stage('renamed-module', (file, text) =>
      file === KOTLIN
        ? text.replace(/Name\(\s*"DidwwVerificationSms"\s*\)/, 'Name("DidwwVerification")')
        : text,
    );

    expect(surfaceProblems(control)).toEqual([
      'module name: JavaScript looks up "DidwwVerificationSms", Kotlin registers "DidwwVerification"',
    ]);
  });

  // Control 2: a config pointing at a class nobody wrote.
  it('would report a declared class that does not match the source', () => {
    const control = stage('missing-class', (file, text) =>
      file === CONFIG ? text.replace(DECLARED_CLASS, 'com.didww.verification.rn.SmsModule') : text,
    );

    expect(surfaceProblems(control)).toEqual([
      'expo-module.config.json declares [com.didww.verification.rn.SmsModule], the Kotlin source is "com.didww.verification.rn.DidwwVerificationSmsModule"',
      `expo-module.config.json declares "com.didww.verification.rn.SmsModule" but ${path.join(KOTLIN_SOURCE_ROOT, 'com', 'didww', 'verification', 'rn', 'SmsModule.kt')} does not exist`,
    ]);
  });

  // Control 3: a method the JavaScript calls and Kotlin has stopped declaring.
  it('would report a method that only one side declares', () => {
    const control = stage('dropped-method', (file, text) =>
      file === KOTLIN ? text.replace(/AsyncFunction\(\s*"stopRetriever"\s*\)[^\n]*/, '') : text,
    );

    expect(surfaceProblems(control)).toEqual([
      'JavaScript calls "stopRetriever", which the Kotlin module does not declare',
    ]);
  });

  // Control 4: the extraction guard itself fires rather than passing on an unreadable source.
  it('would report an extraction that found nothing', () => {
    const control = stage('unparseable', (file, text) => (file === KOTLIN ? '' : text));

    expect(surfaceProblems(control)).toContain('extracted no Name(...) from the Kotlin module');
  });

  // Control 5: a platform this package has no native code for.
  it('would report a platform beyond Android', () => {
    const control = stage('extra-platform', (file, text) =>
      file === CONFIG ? text.replace('["android"]', '["android", "ios"]') : text,
    );

    expect(surfaceProblems(control)).toEqual([
      'expo-module.config.json declares platforms [android,ios], the package ships Android only',
    ]);
  });

  // Control 6: a second declared class, which nothing on the JavaScript side would ever resolve.
  it('would report more than one declared android module', () => {
    const control = stage('second-module', (file, text) =>
      file === CONFIG
        ? text.replace(
            `"${DECLARED_CLASS}"`,
            `"${DECLARED_CLASS}", "com.didww.verification.rn.Two"`,
          )
        : text,
    );

    expect(surfaceProblems(control)).toEqual([
      `expo-module.config.json declares 2 android modules [${DECLARED_CLASS},com.didww.verification.rn.Two], the package has one`,
      `expo-module.config.json declares "com.didww.verification.rn.Two" but ${path.join(KOTLIN_SOURCE_ROOT, 'com', 'didww', 'verification', 'rn', 'Two.kt')} does not exist`,
    ]);
  });
});
