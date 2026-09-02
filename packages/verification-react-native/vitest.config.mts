import { defineConfig } from 'vitest/config';

// jsdom because the hook is rendered with @testing-library/react. No transform block:
// vite 8 transforms JSX with oxc, and an esbuild block here is silently ignored.
export default defineConfig({
  test: { name: 'verification-react-native', environment: 'jsdom' },
});
