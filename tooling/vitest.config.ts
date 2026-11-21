import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  esbuild: { jsx: 'automatic', jsxImportSource: 'react' },
  resolve: {
    // Tests render the page's presentational components; only index.tsx imports the host SDK.
    // ui/src sits outside tooling/, so React resolves from tooling's node_modules for the tests (the bundle keeps it external).
    alias: {
      '@ui': fileURLToPath(new URL('../ui/src', import.meta.url)),
      react: fileURLToPath(new URL('./node_modules/react', import.meta.url)),
      'react-dom': fileURLToPath(new URL('./node_modules/react-dom', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    environment: 'node',
    testTimeout: 120_000,
  },
});
