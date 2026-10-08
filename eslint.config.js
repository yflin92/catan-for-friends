import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

// Globals the engine must never touch (design §2.1, AC19): no wall clock, timers, ambient randomness, I/O or host process.
const ENGINE_FORBIDDEN_GLOBALS = [
  'Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate',
  'queueMicrotask', 'process', 'fetch', 'performance', 'crypto', 'window', 'self', 'document', 'navigator',
].map((name) => ({ name, message: `@hexlands/engine is pure and clock-free; '${name}' is forbidden (design §2.1).` }));

const ENGINE_FORBIDDEN_PROPERTIES = [
  { object: 'Math', property: 'random', message: 'Use a named RNG stream (design §3.5); Math.random is forbidden in the engine.' },
  ...['crypto', 'Date', 'process', 'fetch', 'performance', 'setTimeout', 'setInterval', 'queueMicrotask'].map((property) => ({
    object: 'globalThis',
    property,
    message: `@hexlands/engine is pure and clock-free; globalThis.${property} is forbidden (design §2.1).`,
  })),
];

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', 'tooling/arch-fixtures/**', '**/playwright-report/**', '**/test-results/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      // Only view() may mint the PlayerView brand (design §3.11, ADR-0004); see the override for view.ts below.
      'no-restricted-syntax': [
        'error',
        {
          selector: "TSAsExpression[typeAnnotation.typeName.name='PlayerView']",
          message: 'Only packages/engine/src/view.ts may cast to PlayerView; build views with view(state, seat).',
        },
        {
          selector: "TSTypeAssertion[typeAnnotation.typeName.name='PlayerView']",
          message: 'Only packages/engine/src/view.ts may cast to PlayerView; build views with view(state, seat).',
        },
      ],
    },
  },
  {
    files: ['packages/engine/src/view.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
  },
  {
    // Engine purity (design §2.1, V37). Test files are exempt; the /testing builders are not.
    files: ['packages/engine/src/**/*.ts'],
    ignores: ['packages/engine/src/**/*.test.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-globals': ['error', ...ENGINE_FORBIDDEN_GLOBALS],
      'no-restricted-properties': ['error', ...ENGINE_FORBIDDEN_PROPERTIES],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\.{1,2}/|@noble/hashes(/|$))',
              message: '@hexlands/engine may import only relative modules and @noble/hashes (ADR-0002).',
            },
          ],
        },
      ],
    },
  },
  {
    // Transport-facing code never sees GameState; it handles PlayerView only (design §3.7, AC25).
    files: ['packages/protocol/src/**/*.ts', 'apps/server/src/{ws-gateway,http}.ts', 'apps/server/src/{ws-gateway,http}/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@hexlands/engine',
              importNames: ['GameState'],
              message: 'GameState must not reach transport code; use view(state, seat) → PlayerView (design §3.7).',
            },
          ],
        },
      ],
    },
  },
);
