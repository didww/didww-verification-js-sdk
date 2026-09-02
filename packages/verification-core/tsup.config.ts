import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: `./testing` is a declared subpath, and nothing else builds it.
  entry: ['src/index.ts', 'src/testing/index.ts'],
  format: ['esm', 'cjs'],
  target: 'es2022',
  // Not `node`: this package also runs on Hermes, Bun, Deno and workers.
  platform: 'neutral',
  // tsup's dts pass injects `baseUrl`, which TypeScript 6 rejects outright; the override is what
  // keeps declarations building, not a preference.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  // Off so the emitted filenames are exactly the ones the `exports` map names.
  splitting: false,
  sourcemap: false,
  clean: true,
});
