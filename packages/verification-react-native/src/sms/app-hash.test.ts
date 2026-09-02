import { beforeEach, expect, test, vi } from 'vitest';

import type { NativeSmsModule } from './native.js';
import { getAppHash, wellFormed } from './app-hash.js';

const seam = vi.hoisted(() => ({ module: null as NativeSmsModule | null }));

vi.mock('./native.js', () => ({ getNativeSmsModule: () => seam.module }));

function moduleReturning(getAppHashImpl: () => Promise<string>): NativeSmsModule {
  return {
    getAppHash: getAppHashImpl,
    startRetriever: () => Promise.resolve(),
    stopRetriever: () => Promise.resolve(),
    addListener: () => ({ remove: () => undefined }),
  };
}

beforeEach(() => {
  seam.module = null;
});

// Both optionalities reach this file as the same absent module; native.test.ts tells them apart.
test.each([['expo-modules-core absent'], ['present but the module is not linked']])(
  'resolves null when the native module is unavailable — %s',
  async () => {
    await expect(getAppHash()).resolves.toBeNull();
  },
);

test('resolves the value when the module is linked', async () => {
  seam.module = moduleReturning(() => Promise.resolve('cnXrLKACSkF'));
  await expect(getAppHash()).resolves.toBe('cnXrLKACSkF');
});

test('resolves null rather than rejecting when the native call rejects', async () => {
  seam.module = moduleReturning(() => Promise.reject(new Error('no signature')));
  await expect(getAppHash()).resolves.toBeNull();
});

test('resolves null rather than throwing when the native call throws synchronously', async () => {
  seam.module = moduleReturning(() => {
    throw new Error('module unavailable');
  });
  await expect(getAppHash()).resolves.toBeNull();
});

test.each(['FA+9qCX9VSu', 'cnXrLKACSkF', 'abc/DEF+123'])('wellFormed accepts %s', (hash) => {
  expect(wellFormed(hash)).toBe(true);
});

test.each([
  ['padding', 'FA+9qCX9VS='],
  ['url-safe dash', 'FA-9qCX9VSu'],
  ['url-safe underscore', 'FA_9qCX9VSu'],
  ['ten characters', 'FA+9qCX9VS'],
  ['twelve characters', 'FA+9qCX9VSuX'],
  ['empty', ''],
  ['trailing newline', 'FA+9qCX9VSu\n'],
])('wellFormed rejects %s', (_label, hash) => {
  expect(wellFormed(hash)).toBe(false);
});
