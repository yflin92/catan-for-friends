import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cruise, type ICruiseOptions, type IConfiguration } from 'dependency-cruiser';
import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

// Proves every lint and architecture rule fires on a seeded violation and stays quiet on allowed code.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const depcruiseConfig = createRequire(import.meta.url)(path.join(root, '.dependency-cruiser.cjs')) as IConfiguration;

describe('ESLint rules', () => {
  const eslint = new ESLint({ cwd: root });

  async function ruleIds(relativePath: string, code: string): Promise<string[]> {
    const [result] = await eslint.lintText(code, { filePath: path.join(root, relativePath) });
    return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`);
  }

  describe('engine purity (design §2.1)', () => {
    const engineFile = 'packages/engine/src/probe.ts';

    it.each([
      ['Date', 'export const t = Date.now();', 'no-restricted-globals'],
      ['new Date', 'export const d = new Date(0);', 'no-restricted-globals'],
      ['setTimeout', 'setTimeout(() => undefined, 1);', 'no-restricted-globals'],
      ['setInterval', 'setInterval(() => undefined, 1);', 'no-restricted-globals'],
      ['queueMicrotask', 'queueMicrotask(() => undefined);', 'no-restricted-globals'],
      ['process', 'export const e = process.env;', 'no-restricted-globals'],
      ['fetch', 'export const f = fetch;', 'no-restricted-globals'],
      ['performance', 'export const p = performance.now();', 'no-restricted-globals'],
      ['crypto', 'export const c = crypto.getRandomValues(new Uint8Array(1));', 'no-restricted-globals'],
      ['Math.random', 'export const r = Math.random();', 'no-restricted-properties'],
      ['globalThis.crypto', 'export const c = globalThis.crypto;', 'no-restricted-properties'],
      ['globalThis.Date', 'export const d = globalThis.Date;', 'no-restricted-properties'],
      ['node builtin import', "import fs from 'node:fs';\nexport const x = fs;", 'no-restricted-imports'],
      ['third-party import', "import { z } from 'zod';\nexport const x = z;", 'no-restricted-imports'],
      ['workspace import', "import { x } from '@hexlands/protocol';\nexport const y = x;", 'no-restricted-imports'],
      ['dynamic import()', "export const m = import('./other');", 'no-restricted-syntax'],
      ['globalThis as a value', 'export const g = globalThis;', 'no-restricted-globals'],
      ['globalThis property', 'export const x = globalThis.structuredClone;', 'no-restricted-globals'],
      ['global property', 'export const x = global.Buffer;', 'no-restricted-globals'],
      ['window property', 'export const x = window.location;', 'no-restricted-globals'],
      ['self property', 'export const x = self.origin;', 'no-restricted-globals'],
      ['require()', "export const fs = require('node:fs');", 'no-restricted-globals'],
      ['eval', "export const x = eval('1');", 'no-restricted-globals'],
      ['new Function', "export const f = new Function('return 1');", 'no-restricted-globals'],
      ['Function()', "export const f = Function('return 1');", 'no-restricted-globals'],
      ['globalThis.eval', "export const x = globalThis.eval('1');", 'no-restricted-globals'],
      ['global.Function', "export const f = new global.Function('return 1');", 'no-restricted-globals'],
    ])('rejects %s', async (_name, code, rule) => {
      expect(await ruleIds(engineFile, code)).toContain(rule);
    });

    it('allows relative imports, @noble/hashes and plain pure code', async () => {
      const code = [
        "import { sha256 } from '@noble/hashes/sha2';",
        "import { helper } from './helper';",
        "import { other } from '../other';",
        'export const h = (x: Uint8Array): Uint8Array => sha256(x);',
        'export const n = helper + other + Math.floor(1.5);',
      ].join('\n');
      expect(await ruleIds(engineFile, code)).toEqual([]);
    });

    it('does not flag same-named object properties', async () => {
      const code = 'const o = { self: 1, window: 2, global: 3 };\nexport const n = o.self + o.window + o.global;';
      expect(await ruleIds(engineFile, code)).toEqual([]);
    });

    it('applies to the /testing builders too', async () => {
      expect(await ruleIds('packages/engine/src/testing/probe.ts', 'export const r = Math.random();')).toContain(
        'no-restricted-properties',
      );
    });

    it('does not apply outside the engine', async () => {
      expect(await ruleIds('apps/server/src/probe.ts', 'export const t = Date.now();')).toEqual([]);
    });
  });

  describe('PlayerView brand (design §3.11)', () => {
    const cast = "import type { PlayerView } from '@hexlands/engine';\nexport const v = {} as PlayerView;";
    const assertion = "import type { PlayerView } from '@hexlands/engine';\nexport const v = <PlayerView>{};";

    it('rejects `as PlayerView` outside view.ts', async () => {
      expect(await ruleIds('apps/server/src/probe.ts', cast)).toContain('no-restricted-syntax');
      expect(await ruleIds('packages/protocol/src/probe.ts', cast)).toContain('no-restricted-syntax');
    });

    it('rejects `<PlayerView>` assertions outside view.ts', async () => {
      expect(await ruleIds('apps/server/src/probe.ts', assertion)).toContain('no-restricted-syntax');
    });

    it.each([
      ['a namespace-qualified cast', "import type * as E from '@hexlands/engine';\nexport const v = {} as E.PlayerView;"],
      ['a namespace-qualified assertion', "import type * as E from '@hexlands/engine';\nexport const v = <E.PlayerView>{};"],
      ['a double cast', "import type { PlayerView } from '@hexlands/engine';\nexport const v = {} as unknown as PlayerView;"],
      ['an array cast', "import type { PlayerView } from '@hexlands/engine';\nexport const v = [] as PlayerView[];"],
      ['an aliased import', "import type { PlayerView as PV } from '@hexlands/engine';\nexport const v = {} as PV;"],
      ['a type alias', "import type { PlayerView } from '@hexlands/engine';\ntype PV = PlayerView;\nexport const v = {} as PV;"],
      ['a qualified type alias', "import type * as E from '@hexlands/engine';\ntype PV = E.PlayerView;\nexport const v = {} as PV;"],
      ['a nullable type alias', "import type { PlayerView } from '@hexlands/engine';\ntype PV = PlayerView | null;\nexport const v = {} as PV;"],
    ])('rejects %s outside view.ts', async (_name, code) => {
      expect(await ruleIds('apps/web/src/probe.ts', code)).toContain('no-restricted-syntax');
      expect(await ruleIds('packages/engine/src/reduce.ts', code.replace("'@hexlands/engine'", "'./view'"))).toContain('no-restricted-syntax');
    });

    it('allows using PlayerView as a type without casting, including inside larger types', async () => {
      const code = [
        "import type { PlayerView } from '@hexlands/engine';",
        'export const f = (v: PlayerView): number => v.you;',
        "export type Msg = { readonly t: 'state'; readonly view: PlayerView } | { readonly t: 'none' };",
      ].join('\n');
      expect(await ruleIds('apps/web/src/probe.ts', code)).toEqual([]);
    });

    it('allows the cast in packages/engine/src/view.ts', async () => {
      const local = 'type PlayerView = { readonly you: number };\nexport const v = { you: 0 } as PlayerView;';
      expect(await ruleIds('packages/engine/src/view.ts', local)).toEqual([]);
    });

    it('still rejects the cast in other engine modules, and keeps purity rules in view.ts', async () => {
      const local = 'type PlayerView = { readonly you: number };\nexport const v = { you: 0 } as PlayerView;';
      expect(await ruleIds('packages/engine/src/reduce.ts', local)).toContain('no-restricted-syntax');
      expect(await ruleIds('packages/engine/src/view.ts', "export const m = import('./x');")).toContain('no-restricted-syntax');
      expect(await ruleIds('packages/engine/src/view.ts', 'export const r = Math.random();')).toContain('no-restricted-properties');
    });
  });

  describe('GameState stays out of transport code (design §3.7)', () => {
    const importGameState = "import type { GameState } from '@hexlands/engine';\nexport type S = GameState;";

    it.each(['packages/protocol/src/probe.ts', 'apps/server/src/ws-gateway.ts', 'apps/server/src/http/routes.ts'])(
      'rejects importing GameState in %s',
      async (file) => {
        expect(await ruleIds(file, importGameState)).toContain('no-restricted-imports');
      },
    );

    it('allows GameState in the game room', async () => {
      expect(await ruleIds('apps/server/src/game-room.ts', importGameState)).toEqual([]);
    });
  });
});

describe('dependency-cruiser rules (design §2.1, §3.7, §6.2)', () => {
  const baseOptions: ICruiseOptions = {
    ...(depcruiseConfig.options as ICruiseOptions),
    ruleSet: { forbidden: depcruiseConfig.forbidden ?? [] },
    validate: true,
  };

  type Violation = { rule: { name: string }; from: string; to: string };
  let fixtureViolations: Violation[] = [];

  beforeAll(async () => {
    const result = await cruise(['tooling/arch-fixtures'], { ...baseOptions, exclude: { path: 'node_modules' } });
    const output = result.output as { summary: { violations: Violation[] } };
    fixtureViolations = output.summary.violations;
  }, 60_000);

  const firing = (rule: string): Violation[] => fixtureViolations.filter((v) => v.rule.name === rule);

  it('no-engine-testing-in-apps fires on an app module or *.spec.ts importing the test builders', () => {
    expect(firing('no-engine-testing-in-apps').map((v) => v.from).sort()).toEqual([
      'tooling/arch-fixtures/apps/web/src/violates-spec.spec.ts',
      'tooling/arch-fixtures/apps/web/src/violates-testing.ts',
    ]);
  });

  it('lets a *.test.ts under apps/*/src import the test builders', () => {
    expect(fixtureViolations.filter((v) => v.from === 'tooling/arch-fixtures/apps/web/src/ok-builders.test.ts')).toEqual([]);
  });

  it('no-server-testing-in-prod fires on a production server module importing the server testing entry', () => {
    expect(firing('no-server-testing-in-prod').map((v) => v.from)).toEqual([
      'tooling/arch-fixtures/apps/server/src/violates-server-testing.ts',
    ]);
  });

  it('no-protocol-testing-in-apps fires on an app importing the strict test schemas', () => {
    expect(firing('no-protocol-testing-in-apps').map((v) => v.from)).toEqual([
      'tooling/arch-fixtures/apps/web/src/violates-protocol-testing.ts',
    ]);
  });

  it('engine-internal-is-private fires on an import of internal/* from outside the engine', () => {
    expect(firing('engine-internal-is-private').map((v) => v.from)).toEqual([
      'tooling/arch-fixtures/packages/protocol/src/violates-internal.ts',
    ]);
  });

  it('no-gamestate-in-transport fires on protocol and ws-gateway, not on the game room', () => {
    expect(firing('no-gamestate-in-transport').map((v) => v.from).sort()).toEqual([
      'tooling/arch-fixtures/apps/server/src/ws-gateway.ts',
      'tooling/arch-fixtures/packages/protocol/src/violates-gamestate.ts',
    ]);
  });

  it('engine-is-a-leaf fires on the engine importing another workspace package', () => {
    expect(firing('engine-is-a-leaf').map((v) => v.from)).toEqual([
      'tooling/arch-fixtures/packages/engine/src/violates-leaf.ts',
    ]);
  });

  it('no-production-import-of-tests fires on a production module importing a test file, not on test-to-test imports', () => {
    expect(firing('no-production-import-of-tests').map((v) => v.from)).toEqual([
      'tooling/arch-fixtures/apps/server/src/violates-test-import.ts',
    ]);
  });

  it('reports exactly the seeded violations, one per violates-* fixture (plus ws-gateway.ts)', () => {
    const F = 'tooling/arch-fixtures/';
    expect(fixtureViolations.map((v) => `${v.rule.name}: ${v.from.slice(F.length)}`).sort()).toEqual([
      'engine-internal-is-private: packages/protocol/src/violates-internal.ts',
      'engine-is-a-leaf: packages/engine/src/violates-leaf.ts',
      'no-engine-testing-in-apps: apps/web/src/violates-spec.spec.ts',
      'no-engine-testing-in-apps: apps/web/src/violates-testing.ts',
      'no-gamestate-in-transport: apps/server/src/ws-gateway.ts',
      'no-gamestate-in-transport: packages/protocol/src/violates-gamestate.ts',
      'no-production-import-of-tests: apps/server/src/violates-test-import.ts',
      'no-protocol-testing-in-apps: apps/web/src/violates-protocol-testing.ts',
      'no-server-testing-in-prod: apps/server/src/violates-server-testing.ts',
    ]);
  });

  it('finds no violations in the real workspace', async () => {
    const result = await cruise(['packages', 'apps'], baseOptions);
    const output = result.output as { summary: { violations: Violation[]; error: number } };
    expect(output.summary.violations).toEqual([]);
  }, 60_000);
});
