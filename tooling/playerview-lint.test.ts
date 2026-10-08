import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

// HARD-1 (V37): the type-aware rule hexlands/no-playerview-mint fires on every seeded cast-free bypass and stays quiet on
// legitimate uses. The fixtures live in the apps (so their tsconfigs give them type information) under
// __lint_fixtures__/, which the normal lint run ignores.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root, ignore: false });

async function ruleIds(relativePath: string): Promise<string[]> {
  const [result] = await eslint.lintFiles([path.join(root, relativePath)]);
  return (result?.messages ?? []).map((m) => m.ruleId ?? `fatal: ${m.message}`);
}

const SERVER = 'apps/server/src/__lint_fixtures__/';

describe('type-aware PlayerView lint (HARD-1)', () => {
  it.each([
    ['a generic cast helper instantiated as PlayerView', 'violates-generic.ts'],
    ['an any-typed JSON.parse result assigned to a PlayerView', 'violates-json-parse.ts'],
    ['an any returned as a PlayerView', 'violates-return-any.ts'],
    ['an any passed where a PlayerView is expected', 'violates-argument.ts'],
  ])('fails on %s', async (_name, file) => {
    expect(await ruleIds(SERVER + file)).toEqual(['hexlands/no-playerview-mint']);
  }, 60_000);

  it('passes view() output, and generic helpers applied to an existing PlayerView', async () => {
    expect(await ruleIds(SERVER + 'ok-view.ts')).toEqual([]);
  }, 60_000);

  it('passes PlayerViewWire / ViewLike uses in apps/web', async () => {
    expect(await ruleIds('apps/web/src/__lint_fixtures__/ok-wire.ts')).toEqual([]);
  }, 60_000);

  it('does not apply to packages/engine/src/view.ts, the one module that mints PlayerView', async () => {
    expect(await ruleIds('packages/engine/src/view.ts')).toEqual([]);
  }, 60_000);
});
