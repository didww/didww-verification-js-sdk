import { describe, expect, test, vi } from 'vitest';

import type { ExpoModulesCore, NativeSmsModule } from './native.js';
import {
  getNativeSmsModule,
  isSmsAutoCaptureAvailable,
  resolveNativeSmsModule,
  supportsAutoCapture,
} from './native.js';

function linkedModule(overrides: Partial<NativeSmsModule> = {}): NativeSmsModule {
  return {
    getAppHash: () => Promise.resolve('FA+9qCX9VSu'),
    startRetriever: () => Promise.resolve(),
    stopRetriever: () => Promise.resolve(),
    addListener: () => ({ remove: () => undefined }),
    ...overrides,
  };
}

function coreReturning(module: NativeSmsModule | null): ExpoModulesCore {
  return { requireOptionalNativeModule: vi.fn(() => module) } as unknown as ExpoModulesCore;
}

describe('expo-modules-core absent', () => {
  // Not mocked: the package is genuinely not installed in this workspace, so the try/catch require
  // in native.ts takes its catch branch for real here.
  test('no module resolves', () => {
    expect(getNativeSmsModule()).toBeNull();
  });

  test('auto-capture is unavailable', () => {
    expect(isSmsAutoCaptureAvailable()).toBe(false);
  });

  test('resolution short-circuits without consulting the second optionality', () => {
    expect(resolveNativeSmsModule(null)).toBeNull();
    expect(supportsAutoCapture(resolveNativeSmsModule(null))).toBe(false);
  });
});

describe('expo-modules-core present', () => {
  test('asks for the name the Android module registers', () => {
    const core = coreReturning(linkedModule());
    resolveNativeSmsModule(core);
    expect(core.requireOptionalNativeModule).toHaveBeenCalledWith('DidwwVerificationSms');
  });

  test('module not linked resolves null and reports unavailable', () => {
    const module = resolveNativeSmsModule(coreReturning(null));
    expect(module).toBeNull();
    expect(supportsAutoCapture(module)).toBe(false);
  });

  test('module linked and exposing startRetriever reports available', () => {
    const module = resolveNativeSmsModule(coreReturning(linkedModule()));
    expect(module).not.toBeNull();
    expect(supportsAutoCapture(module)).toBe(true);
  });

  test('module linked without startRetriever reports unavailable', () => {
    const withoutRetriever = linkedModule();
    delete (withoutRetriever as Partial<NativeSmsModule>).startRetriever;
    const module = resolveNativeSmsModule(coreReturning(withoutRetriever));
    expect(module).not.toBeNull();
    expect(supportsAutoCapture(module)).toBe(false);
  });
});
