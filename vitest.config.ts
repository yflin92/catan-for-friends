import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tooling/arch-fixtures/**'],
    passWithNoTests: true,
    // CPU-bound tests share the runner with the E-INT walker shards (about 100 s each), so the 5 s default flakes under
    // load; a real hang still fails within 30 s.
    testTimeout: 30_000,
  },
});
