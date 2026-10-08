import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'],
    // The E-INT walker shards run in their own CI job (`pnpm test:walker`), so they never compete with this suite.
    exclude: ['**/node_modules/**', 'tooling/arch-fixtures/**', ...(process.env['HEXLANDS_WALKER'] === '1' ? [] : ['**/__integration__/walker-*.test.ts'])],
    passWithNoTests: true,
  },
});
