// Architecture rules (design §2.1, §3.7, §6.2). Path patterns allow a leading directory so that the same rules can be
// exercised against the seeded-violation tree in tooling/arch-fixtures.
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-engine-testing-in-apps',
      comment: '@hexlands/engine/testing is test-only; application source must not import it (design §2.1).',
      severity: 'error',
      from: { path: '(^|/)apps/[^/]+/src/', pathNot: '\\.test\\.tsx?$' },
      to: { path: '(^|/)packages/engine/src/testing/' },
    },
    {
      name: 'no-server-testing-in-prod',
      comment: 'apps/server/src/testing is test-only; production server modules must not import it (design §3.12, G4).',
      severity: 'error',
      from: { path: '(^|/)apps/server/src/', pathNot: '(\\.test\\.tsx?$|(^|/)apps/server/src/testing/)' },
      to: { path: '(^|/)apps/server/src/testing/' },
    },
    {
      name: 'no-protocol-testing-in-apps',
      comment: '@hexlands/protocol/testing (strict CI schemas) is test-only; application source must not import it (D6).',
      severity: 'error',
      from: { path: '(^|/)apps/[^/]+/src/', pathNot: '\\.test\\.tsx?$' },
      to: { path: '(^|/)packages/protocol/src/testing/' },
    },
    {
      name: 'engine-internal-is-private',
      comment: 'packages/engine/src/internal/* is reachable only from inside packages/engine/src (design §6.2).',
      severity: 'error',
      from: { pathNot: '(^|/)packages/engine/src/' },
      to: { path: '(^|/)packages/engine/src/internal/' },
    },
    {
      name: 'no-gamestate-in-transport',
      comment: 'ws-gateway, http and the protocol package must not import the GameState module (design §3.7, AC25).',
      severity: 'error',
      from: { path: '(^|/)(apps/server/src/(ws-gateway|http)([./]|$)|packages/protocol/src/)' },
      to: { path: '(^|/)packages/engine/src/state\\.ts$' },
    },
    {
      name: 'engine-is-a-leaf',
      comment: 'The engine depends on nothing else in the workspace (ADR-0002).',
      severity: 'error',
      from: { path: '(^|/)packages/engine/src/' },
      to: { path: '(^|/)(packages/protocol|apps)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(node_modules|dist)/|^tooling/arch-fixtures/' },
    tsPreCompilationDeps: true,
    combinedDependencies: false,
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types'],
      extensions: ['.ts', '.tsx', '.js', '.mjs', '.cjs'],
    },
  },
};
