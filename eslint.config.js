import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import noPlayerViewMint from './tooling/eslint/no-playerview-mint.js';

// Globals the engine must never touch (design §2.1, AC19): no wall clock, timers, ambient randomness, I/O or host process.
const ENGINE_FORBIDDEN_GLOBALS = [
  'Date', 'setTimeout', 'setInterval', 'setImmediate', 'clearTimeout', 'clearInterval', 'clearImmediate',
  'queueMicrotask', 'process', 'fetch', 'performance', 'crypto', 'window', 'self', 'document', 'navigator',
  'global', 'globalThis', 'require', 'module', 'eval', 'Function',
].map((name) => ({ name, message: `@hexlands/engine is pure and clock-free; '${name}' is forbidden (design §2.1).` }));

// Only view() may mint the PlayerView brand (design §3.11, ADR-0004). A cast is rejected when PlayerView appears anywhere
// in it, plain or namespace-qualified (`as PlayerView`, `as E.PlayerView`, `as PlayerView[]`, `<PlayerView>`). Renaming
// the type is rejected too: an aliased import, or a type alias that is PlayerView or has it as a direct union or
// intersection member. Types that merely contain a PlayerView field (e.g. a message union) stay allowed.
const PLAYER_VIEW_CAST_MESSAGE = 'Only packages/engine/src/view.ts may cast to PlayerView; build views with view(state, seat).';
const PLAYER_VIEW_RENAME_MESSAGE = 'Do not rename PlayerView (aliased import or type alias); only view(state, seat) creates one.';
const PLAYER_VIEW_CAST_SELECTORS = [
  ...[`TSTypeReference[typeName.name='PlayerView']`, `TSTypeReference[typeName.right.name='PlayerView']`].map((ref) => ({
    selector: `:matches(TSAsExpression, TSTypeAssertion) ${ref}`,
    message: PLAYER_VIEW_CAST_MESSAGE,
  })),
  { selector: `ImportSpecifier[imported.name='PlayerView'][local.name!='PlayerView']`, message: PLAYER_VIEW_RENAME_MESSAGE },
  ...[`[typeName.name='PlayerView']`, `[typeName.right.name='PlayerView']`].flatMap((name) => [
    { selector: `TSTypeAliasDeclaration > TSTypeReference${name}`, message: PLAYER_VIEW_RENAME_MESSAGE },
    {
      selector: `TSTypeAliasDeclaration > :matches(TSUnionType, TSIntersectionType) > TSTypeReference${name}`,
      message: PLAYER_VIEW_RENAME_MESSAGE,
    },
  ]),
];

// An expression-bodied effect returns its value to React as the cleanup; a non-function (e.g. the Promise
// scrollIntoView returns in Chrome) crashes the page when the effect re-runs.
const REACT_EFFECT_SELECTOR = {
  selector:
    "CallExpression[callee.name=/^use(Layout|Insertion)?Effect$/] > ArrowFunctionExpression.arguments:first-child[body.type!='BlockStatement']",
  message: 'Give effect callbacks a block body; an expression body returns its value to React as the cleanup.',
};

const ENGINE_DYNAMIC_IMPORT_SELECTOR = {
  selector: 'ImportExpression',
  message: '@hexlands/engine loads no code at runtime; dynamic import() is forbidden (design §2.1).',
};

const ENGINE_FORBIDDEN_PROPERTIES = [
  { object: 'Math', property: 'random', message: 'Use a named RNG stream (design §3.5); Math.random is forbidden in the engine.' },
  ...['crypto', 'Date', 'process', 'fetch', 'performance', 'setTimeout', 'setInterval', 'queueMicrotask'].map((property) => ({
    object: 'globalThis',
    property,
    message: `@hexlands/engine is pure and clock-free; globalThis.${property} is forbidden (design §2.1).`,
  })),
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'tooling/arch-fixtures/**',
      // Seeded type-aware lint fixtures; tooling/playerview-lint.test.ts lints them explicitly.
      '**/__lint_fixtures__/**',
      '**/playwright-report/**',
      '**/test-results/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { plugins: { hexlands: { rules: { 'no-playerview-mint': noPlayerViewMint } } } },
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': ['error', ...PLAYER_VIEW_CAST_SELECTORS],
    },
  },
  {
    files: ['apps/web/src/**/*.{ts,tsx}'],
    languageOptions: { globals: { ...globals.browser } },
    rules: {
      // A files override replaces the rule's options, so the shared PlayerView selectors are repeated here.
      'no-restricted-syntax': ['error', ...PLAYER_VIEW_CAST_SELECTORS, REACT_EFFECT_SELECTOR],
    },
  },
  {
    // Engine purity (design §2.1, V37). Test files are exempt; the /testing builders are not.
    files: ['packages/engine/src/**/*.ts'],
    ignores: ['packages/engine/src/**/*.test.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-syntax': ['error', ...PLAYER_VIEW_CAST_SELECTORS, ENGINE_DYNAMIC_IMPORT_SELECTOR],
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
    // view.ts is the one module allowed to cast to PlayerView; it stays subject to the rest of the purity rules.
    files: ['packages/engine/src/view.ts'],
    rules: { 'no-restricted-syntax': ['error', ENGINE_DYNAMIC_IMPORT_SELECTOR] },
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
  {
    // Type-aware PlayerView protection (HARD-1, design §3.7): no any-typed value or generic helper may produce a
    // PlayerView outside view.ts. Type information comes from each package's tsconfig (projectService).
    files: ['packages/*/src/**/*.{ts,tsx}', 'apps/*/src/**/*.{ts,tsx}'],
    ignores: ['packages/engine/src/view.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: { 'hexlands/no-playerview-mint': 'error' },
  },
  {
    // The server's view send path: no any-typed value may be assigned, returned or passed on (HARD-1).
    files: ['apps/server/src/{ws-gateway,game-room,hello,room-view,resync}.ts', 'apps/server/src/ws-gateway/**/*.ts'],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
      '@typescript-eslint/no-unsafe-argument': 'error',
    },
  },
);
