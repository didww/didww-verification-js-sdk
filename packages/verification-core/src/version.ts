/**
 * Mirrors `package.json`'s `version`. Hand-kept rather than read at runtime — a published package
 * cannot rely on resolving its own `package.json` from every bundler this runs under (a browser
 * bundle in particular). `scripts/check-version-constants.mjs` fails CI if the two drift.
 */
export const CORE_VERSION = '1.1.0';
