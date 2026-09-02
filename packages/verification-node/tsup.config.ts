import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  target: 'es2022',
  // Unlike core, this package is Node-only: it signs with `node:crypto`.
  platform: 'node',
  // The one real dependency. Bundling it would ship a second copy of core's error classes, and
  // `isDidwwError` would then disagree with the consumer's own.
  external: ['@didww/verification-core'],
  // tsup's dts pass injects `baseUrl`, which TypeScript 6 rejects outright; the override is what
  // keeps declarations building, not a preference.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  // Off so the emitted filenames are exactly the ones the `exports` map names.
  splitting: false,
  sourcemap: false,
  clean: true,
});
