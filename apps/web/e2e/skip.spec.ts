// AC28 skip flow through the UI (design §5.10, DR4). The server runs on a FakeClock and starts the game in preRoll
// (seat 0, the host, to roll) with the dice scripted to a 7: Ana (seat 0) and Bo (seat 1) both hold more than 7 cards.
// Ana leaves; after skipAfterSec, Bo (host away → any seated player may skip) skips her. The auto-roll is a 7, Ana's
// own discard resolves at once and Bo still owes, so every page shows "Turn skipped — it ends after discards" (DR4).
// Ana reconnects: she sees the same banner and has nothing to do.
import { test as base, expect, type Page } from '@playwright/test';
import { buildState } from '@hexlands/engine/testing';
import { FakeClock } from '@hexlands/server/testing';
import { contextPoolFixture, startHarness, type ContextPool, type Harness } from './harness';

const clock = new FakeClock(Date.UTC(2026, 9, 8, 12));

const test = base.extend<{ pages: ContextPool }, { harness: Harness }>({
  pages: contextPoolFixture,
  harness: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require an object pattern
    async ({}, use) => {
      // testHooks (the injected start state) are honoured only with the test-hook gate on (design D2).
      const saved = process.env['HEXLANDS_TEST_HOOKS'];
      process.env['HEXLANDS_TEST_HOOKS'] = '1';
      const h = await startHarness({
        clock,
        testHooks: {
          initialState: () =>
            buildState({
              playerCount: 3,
              phase: { name: 'preRoll' },
              turn: { number: 1, active: 0 },
              hands: { 0: { ore: 4, wool: 4 }, 1: { brick: 5, grain: 4 } },
              rng: { dice: { scripted: [3, 4] } },
            }),
        },
      });
      if (saved === undefined) delete process.env['HEXLANDS_TEST_HOOKS'];
      else process.env['HEXLANDS_TEST_HOOKS'] = saved;
      await use(h);
      await h.close();
    },
    { scope: 'worker' },
  ],
  baseURL: async ({ harness }, use) => {
    await use(harness.baseURL);
  },
});

/** Moves the server's FakeClock forward in steps, so the pages keep answering heartbeats in real time. */
async function advance(p: Page, ms: number): Promise<void> {
  for (let left = ms; left > 0; left -= 5_000) {
    clock.advance(Math.min(5_000, left));
    await p.waitForTimeout(50);
  }
}

test('skip an absent host: Skip button for a seated player, DR4 banner everywhere, the skipped seat rejoins with no actions', async ({ pages, harness }) => {
  const ana = await pages.page(harness.baseURL);
  await ana.goto('/');
  await ana.locator('input[name="hostName"]').fill('Ana');
  await ana.getByRole('button', { name: 'Create game' }).click();
  const code = (await ana.locator('input[name="invite"]').inputValue()).split('#join=')[1]!;
  const rejoin = await ana.locator('input[name="rejoin"]').inputValue();
  const others: Page[] = [];
  for (const name of ['Bo', 'Cy']) {
    const p = await pages.page(harness.baseURL);
    await p.goto(`/#join=${code}`);
    await p.locator('input[name="displayName"]').fill(name);
    await p.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(p.locator('[data-roster-seat] .tag', { hasText: 'you' })).toBeVisible();
    others.push(p);
  }
  const [bo, cy] = others as [Page, Page];
  await ana.getByRole('button', { name: 'Start game' }).click();
  await expect(bo.locator('#app')).toHaveAttribute('data-lifecycle', 'active');
  await expect(bo.locator('[data-notice="waiting"]')).toContainText('Waiting for Ana');

  // Ana leaves. Under the threshold there is no Skip button.
  await ana.context().close();
  await expect(bo.locator('[data-notice="waiting"]')).toContainText('Waiting for Ana (');
  await expect(bo.getByRole('button', { name: 'Skip' })).toHaveCount(0);
  await advance(bo, 60_000);
  await expect(bo.getByRole('button', { name: 'Skip' })).toBeVisible();

  await bo.getByRole('button', { name: 'Skip' }).click();
  for (const p of [bo, cy]) await expect(p.locator('[data-notice="turn-skipped"]')).toHaveText('Turn skipped — it ends after discards');
  await expect(bo.getByRole('dialog', { name: 'Discard' })).toBeVisible();

  // Ana comes back on her rejoin link: the banner, and nothing for her to do.
  const back = await pages.page(harness.baseURL);
  await back.goto(rejoin);
  await expect(back.locator('#app')).toHaveAttribute('data-lifecycle', 'active');
  await expect(back.locator('[data-notice="turn-skipped"]')).toHaveText('Turn skipped — it ends after discards');
  await expect(back.getByRole('dialog', { name: 'Discard' })).toHaveCount(0);
  await expect(back.getByRole('button', { name: 'Roll dice' })).toHaveCount(0);
  await expect(back.getByRole('button', { name: 'End turn' })).toHaveCount(0);
});
