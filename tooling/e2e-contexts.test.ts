// Browser contexts in the e2e specs (bugs 87294a8315b24921807a1020 (c) and 4b57684e7fffa790ce27d686): every spec opens
// its players through the harness ContextPool (`pages.page(baseURL)`, or Playwright's own `page`/`context` fixtures),
// which closes them when the test ends. A spec that calls `newContext` itself can leak contexts across tests, and a
// WebKit worker stalls once enough are left open. Every *.spec.ts in apps/web/e2e is checked unless listed in ALLOWED
// with the reason it is safe.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const E2E = new URL('../apps/web/e2e/', import.meta.url);
/** Specs allowed to call newContext themselves, with why their contexts cannot outlive the test. None today. */
const ALLOWED: Readonly<Record<string, string>> = {};

/** Spec files that create a browser context directly, other than those in ALLOWED. */
export function rawContextSpecs(files: readonly { name: string; source: string }[], allowed: Readonly<Record<string, string>> = ALLOWED): string[] {
  return files.filter((f) => !(f.name in allowed) && /\.newContext\(/.test(f.source)).map((f) => f.name);
}

const specs = readdirSync(E2E)
  .filter((name) => name.endsWith('.spec.ts'))
  .map((name) => ({ name, source: readFileSync(new URL(name, E2E), 'utf8') }));

describe('e2e specs open browser contexts only through the ContextPool', () => {
  it('finds the spec files', () => {
    expect(specs.map((s) => s.name)).toEqual(expect.arrayContaining(['full-game.spec.ts', 'mobile.spec.ts', 'skip.spec.ts', 'reload.spec.ts']));
  });

  it('no spec calls newContext itself', () => {
    expect(rawContextSpecs(specs), 'a direct newContext() call can leak the context past the test').toEqual([]);
  });

  it('a spec with a raw newContext() call is caught, and an allowlisted one is not', () => {
    const seeded = [{ name: 'seeded.spec.ts', source: 'const p = await (await browser.newContext({ baseURL })).newPage();' }];
    expect(rawContextSpecs(seeded)).toEqual(['seeded.spec.ts']);
    expect(rawContextSpecs(seeded, { 'seeded.spec.ts': 'closes its own contexts' })).toEqual([]);
  });
});
