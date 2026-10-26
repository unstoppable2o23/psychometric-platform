import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // PGlite is an embedded single-writer database bound to one data directory,
    // so every file must share a single process and run serially.
    pool: 'forks',
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120_000,
    hookTimeout: 180_000,
    env: {
      NODE_ENV: 'test',
      PGLITE_DATA_DIR: '.pglite-test',
      // Deterministic so the token generator is reproducible in assertions.
      AUTH_SECRET: 'test-secret-value-not-for-production-use',
      NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      // The real package throws unless imported inside a React Server Component
      // graph, which is the opposite of what a plain Node test runner needs.
      'server-only': path.resolve(__dirname, 'tests/stubs/server-only.ts'),
    },
  },
});
