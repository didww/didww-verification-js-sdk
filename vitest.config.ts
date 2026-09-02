import { coverageConfigDefaults, defineConfig } from 'vitest/config';

// Vitest 4 removed `vitest.workspace.ts`; multi-package runs are declared here.
export default defineConfig({
  test: {
    // Builds the workspace once before any file runs; see the file for why.
    globalSetup: ['./vitest.global-setup.mjs'],
    projects: [
      'packages/*',
      {
        // `packages/*` does not reach the CI gates in scripts/, and their
        // negative controls shell out to npm and esbuild, so they need room.
        test: {
          name: 'scripts',
          root: import.meta.dirname,
          include: ['scripts/**/*.test.mjs'],
          // The end-to-end oracle boots two servers of its own and would compete with the
          // HTTP tests in `packages/*`, timing them out perhaps one run in three. CI runs it
          // as its own job; locally it is `npm run test:e2e`.
          exclude: ['scripts/node-server-e2e.test.mjs'],
          testTimeout: 180_000,
          hookTimeout: 60_000,
        },
      },
      {
        test: {
          name: 'e2e',
          root: import.meta.dirname,
          include: ['scripts/node-server-e2e.test.mjs'],
          testTimeout: 180_000,
          hookTimeout: 60_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**/*.{ts,tsx}'],
      // Type-level assertion files are checked by `tsc`, never executed, so they would sit at 0%
      // forever and eat the thresholds below.
      exclude: [...coverageConfigDefaults.exclude, 'packages/*/src/**/*.type-assertions.ts'],
      thresholds: {
        'packages/verification-core/src/**': {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'packages/verification-node/src/**': {
          statements: 90,
          branches: 90,
          functions: 90,
          lines: 90,
        },
        'packages/verification-react-native/src/**': {
          statements: 80,
          branches: 80,
          functions: 80,
          lines: 80,
        },
      },
    },
  },
});
