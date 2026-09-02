import { getNativeSmsModule } from './native.js';

// Exactly 11 characters of standard base64 — no padding, and not the URL-safe alphabet.
const APP_HASH_PATTERN = /^[A-Za-z0-9+/]{11}$/;

/** Whether a value has the shape of an app hash. Says nothing about it being the right one. */
export function wellFormed(hash: string): boolean {
  return APP_HASH_PATTERN.test(hash);
}

/**
 * This build's app hash, or `null` wherever the native module is unavailable — iOS, Expo Go, and a
 * bare app without Expo Modules. Never rejects.
 */
export async function getAppHash(): Promise<string | null> {
  const module = getNativeSmsModule();
  if (module === null) {
    return null;
  }
  try {
    return await module.getAppHash();
  } catch {
    return null;
  }
}
