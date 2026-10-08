// Browser contexts in the e2e specs (bug 87294a8315b24921807a1020 (c)): the multi-player specs open every player
// through the harness ContextPool (`pages.page(baseURL)`), which closes them when the test ends. A spec that creates
// contexts with `browser.newContext` itself leaks them across tests, and one WebKit worker stalls in the nightly run.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const SPECS = ['full-game', 'mobile', 'relink', 'game-log'] as const;

describe('e2e specs open browser contexts only through the ContextPool', () => {
  for (const name of SPECS) {
    it(`${name}.spec.ts`, () => {
      const source = readFileSync(new URL(`../apps/web/e2e/${name}.spec.ts`, import.meta.url), 'utf8');
      expect(source, 'a direct newContext() call leaks the context past the test').not.toMatch(/\.newContext\(/);
      expect(source).toMatch(/\.page\(/);
    });
  }
});
