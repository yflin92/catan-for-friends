import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'],
    // The E-INT walker shards and the AC30 secrets scan run in their own CI jobs (`pnpm test:walker`,
    // `pnpm test:ac30`), so they never compete with this suite.
    exclude: [
      '**/node_modules/**',
      'tooling/arch-fixtures/**',
      ...(process.env['HEXLANDS_WALKER'] === '1' ? [] : ['**/__integration__/walker-*.test.ts']),
      ...(process.env['HEXLANDS_AC30_SCAN'] === '1' ? [] : ['apps/server/src/secrets-scan.test.ts']),
    ],
    passWithNoTests: true,
  },
});
