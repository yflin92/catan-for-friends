// Regression (bug 9a22092cfbfa5a6a3d95a8b0): a new log entry re-runs the log panel's scroll effect. In real Chromium an
// expression-bodied effect returned scrollIntoView()'s Promise as the cleanup and blanked every game page. Runs a real
// game through the UI in real browsers until a new log entry arrives.
import type { Page } from '@playwright/test';
import { expect, isEngineConsoleError, test, type ContextPool } from './harness';

interface Player {
  readonly page: Page;
  readonly errors: string[];
}

/** A player: a page in its own context from `pool` (closed when the test ends) that collects console errors. */
async function player(pool: ContextPool, engine: string, baseURL: string): Promise<Player> {
  const page = await pool.page(baseURL);
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !isEngineConsoleError(engine, m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return { page, errors };
}

test('a new log entry keeps every game page rendered with no console errors', async ({ pages, browserName, harness }) => {
  const join = () => player(pages, browserName, harness.baseURL);
  const players = [await join(), await join(), await join()];
  const host = players[0]!.page;
  await host.goto('/');
  await host.locator('input[name="hostName"]').fill('Ana');
  await host.getByRole('button', { name: 'Create game' }).click();
  const code = (await host.locator('input[name="invite"]').inputValue()).split('#join=')[1]!;
  for (const [i, name] of ['Bo', 'Cy'].entries()) {
    const p = players[i + 1]!.page;
    await p.goto(`/#join=${code}`);
    await p.locator('input[name="displayName"]').fill(name);
    await p.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(p.locator('[data-roster-seat] .tag', { hasText: 'you' })).toBeVisible();
  }
  await host.getByRole('button', { name: 'Start game' }).click();
  for (const { page } of players) await expect(page.locator('#app')).toHaveAttribute('data-lifecycle', 'active');

  // Seat 0 (the host) places its starting settlement; that commit adds a log entry on every page.
  const active = host;
  await expect(active.locator('[data-target-vertex]').first()).toBeVisible();
  await active.locator('[data-target-vertex]').first().click();
  await active.getByRole('button', { name: 'Confirm', exact: true }).click();

  for (const { page } of players) {
    await expect(page.locator('.log [data-log-n]').first()).toBeVisible();
    await expect(page.locator('#app')).toHaveAttribute('data-seq', '1');
  }
  // Let any effect cleanups run, then the pages must still be rendered.
  await host.waitForTimeout(300);
  for (const { page, errors } of players) {
    await expect(page.locator('#app .board-svg')).toBeVisible();
    await expect(page.locator('.log')).toBeVisible();
    expect(errors).toEqual([]);
  }
});
