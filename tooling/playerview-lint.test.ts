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
  return (result?.messages ?? []).map((m) => (m.ruleId === RULE ? `${RULE}:${m.messageId}` : (m.ruleId ?? `fatal: ${m.message}`)));
}

const RULE = 'hexlands/no-playerview-mint';
const any = `${RULE}:anyIntoView`;
const generic = `${RULE}:genericMint`;
const predicate = `${RULE}:viewPredicate`;
const assertion = `${RULE}:typeParamAssertion`;
const overload = `${RULE}:viewOverload`;

const SERVER = 'apps/server/src/__lint_fixtures__/';

describe('type-aware PlayerView lint (HARD-1)', () => {
  it.each([
    ['a generic cast helper instantiated as PlayerView', 'violates-generic.ts', [assertion, generic]],
    ['an any-typed JSON.parse result assigned to a PlayerView', 'violates-json-parse.ts', [any]],
    ['an any returned as a PlayerView', 'violates-return-any.ts', [any]],
    ['an any passed where a PlayerView is expected', 'violates-argument.ts', [any]],
    ['an any parameter default as a PlayerView', 'violates-param-default.ts', [any]],
    ['an any class-field initialiser as a PlayerView', 'violates-class-field.ts', [any]],
    ['a generic helper returning Promise<T> instantiated as PlayerView', 'violates-generic-promise.ts', [assertion, generic]],
    ['a generic helper returning T | undefined instantiated as PlayerView', 'violates-generic-union.ts', [assertion, generic]],
    ['a generic helper returning T[] instantiated as PlayerView', 'violates-generic-array.ts', [assertion, generic]],
    ['a type predicate narrowing to PlayerView', 'violates-predicate.ts', [predicate]],
    ['an assertion signature narrowing to PlayerView', 'violates-asserts.ts', [predicate]],
    ['an any into an object type holding a PlayerView', 'violates-wrapper.ts', [any]],
    ['a class-level type parameter cast (Box<T>.get())', 'violates-class-generic.ts', [assertion]],
    ['a generic helper returning Map<string, T>', 'violates-generic-map.ts', [assertion]],
    ['a generic helper returning { value: T }', 'violates-generic-object.ts', [assertion]],
    ['a generic helper returning Set<T>', 'violates-generic-set.ts', [assertion]],
    ['a generic helper handing a cast T to a callback', 'violates-generic-callback.ts', [assertion]],
    ['`as never` into a PlayerView slot', 'violates-as-never.ts', [any]],
    ['an overload signature returning PlayerView', 'violates-overload.ts', [overload]],
  ])('fails on %s', async (_name, file, expected) => {
    expect(await ruleIds(SERVER + file)).toEqual(expected);
  }, 60_000);

  it('passes view() output, generic helpers applied to an existing PlayerView, and collections/promises of views', async () => {
    expect(await ruleIds(SERVER + 'ok-view.ts')).toEqual([]);
  }, 60_000);

  it('passes PlayerViewWire / ViewLike uses in apps/web', async () => {
    expect(await ruleIds('apps/web/src/__lint_fixtures__/ok-wire.ts')).toEqual([]);
  }, 60_000);

  it('does not apply to packages/engine/src/view.ts, the one module that mints PlayerView', async () => {
    expect(await ruleIds('packages/engine/src/view.ts')).toEqual([]);
  }, 60_000);
});
