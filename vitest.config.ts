import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.{ts,tsx}', 'tooling/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tooling/arch-fixtures/**'],
    passWithNoTests: true,
  },
});
