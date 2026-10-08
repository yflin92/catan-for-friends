Seeded violations for the dependency-cruiser rules in `.dependency-cruiser.cjs`. The tree mirrors the repo layout so the
same path patterns apply. Files named `violates-*` (and `apps/server/src/ws-gateway.ts`) each break exactly one rule;
`tooling/arch-rules.test.ts` asserts that every rule fires here and that the real workspace is clean. This directory is
excluded from the real dependency-cruiser run, ESLint, tsc and vitest.
