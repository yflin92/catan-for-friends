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

    it('allows the cast in packages/engine/src/view.ts', async () => {
      const local = 'type PlayerView = { readonly you: number };\nexport const v = { you: 0 } as PlayerView;';
      expect(await ruleIds('packages/engine/src/view.ts', local)).toEqual([]);
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

  it('no-engine-testing-in-apps fires on an app importing the test builders', () => {
    expect(firing('no-engine-testing-in-apps').map((v) => v.from)).toEqual([
      'tooling/arch-fixtures/apps/web/src/violates-testing.ts',
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

  it('reports nothing beyond the seeded violations', () => {
    expect(fixtureViolations).toHaveLength(5);
  });

  it('finds no violations in the real workspace', async () => {
    const result = await cruise(['packages', 'apps'], baseOptions);
    const output = result.output as { summary: { violations: Violation[]; error: number } };
    expect(output.summary.violations).toEqual([]);
  }, 60_000);
});
