// X-relink-FU (AC24, Q8): the host reissues a seat's link from the in-game players panel. The seat's old socket is
// closed 4401 (seat_token_revoked) and its page says the link no longer works, as does the old link reopened; the new
// link takes the same seat in a fresh browser; the host's own session stays bound and keeps playing. Non-hosts have no
// control.
import type { Browser, Page } from '@playwright/test';
import { expect, isEngineConsoleError, test } from './harness';

/** Records the close code of every WebSocket the page opens, in window.__wsCloseCodes. */
const RECORD_CLOSE_CODES = () => {
  const codes: number[] = [];
  (window as unknown as { __wsCloseCodes: number[] }).__wsCloseCodes = codes;
  const Native = window.WebSocket;
  window.WebSocket = class extends Native {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.addEventListener('close', (e) => codes.push(e.code));
    }
  };
};

async function player(browser: Browser, baseURL: string): Promise<{ page: Page; errors: string[] }> {
  const page = await (await browser.newContext({ baseURL })).newPage();
  const errors: string[] = [];
  const engine = browser.browserType().name();
  page.on('console', (m) => {
    if (m.type() === 'error' && !isEngineConsoleError(engine, m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(RECORD_CLOSE_CODES);
  return { page, errors };
}

const storedToken = (page: Page, code: string) =>
  page.evaluate((c) => (JSON.parse(localStorage.getItem(`hexlands.seat.${c}`) ?? 'null') as { seatToken: string } | null)?.seatToken ?? null, code);

test('the host reissues a seat link in-game: old socket 4401, new link takes the seat, host stays bound', async ({ browser, harness }) => {
  const [ann, bo, cy] = [await player(browser, harness.baseURL), await player(browser, harness.baseURL), await player(browser, harness.baseURL)];
  await ann.page.goto('/');
  await ann.page.locator('input[name="hostName"]').fill('Ann');
  await ann.page.getByRole('button', { name: 'Create game' }).click();
  const code = (await ann.page.locator('input[name="invite"]').inputValue()).split('#join=')[1]!;
  for (const [p, name] of [[bo!, 'Bo'], [cy!, 'Cy']] as const) {
    await p.page.goto(`/#join=${code}`);
    await p.page.locator('input[name="displayName"]').fill(name);
    await p.page.getByRole('button', { name: 'Join', exact: true }).click();
    await expect(p.page.locator('[data-roster-seat] .tag', { hasText: 'you' })).toBeVisible();
  }
  await ann.page.getByRole('button', { name: 'Start game' }).click();
  for (const p of [ann!, bo!, cy!]) await expect(p.page.locator('#app')).toHaveAttribute('data-lifecycle', 'active');
  const hostToken = await storedToken(ann.page, code);
  const boToken = await storedToken(bo!.page, code);

  // Only the host has the control, and never for its own seat.
  await expect(bo!.page.locator('button[aria-label^="Reissue link"]')).toHaveCount(0);
  await expect(ann.page.getByRole('button', { name: 'Reissue link for seat 1' })).toHaveCount(0);

  await ann.page.getByRole('button', { name: 'Reissue link for seat 2' }).click();
  const newLink = await ann.page.locator('input[name="relinked-1"]').inputValue();
  const newToken = newLink.split('#seat=')[1]!.split('.')[1]!;
  expect(newLink).toMatch(new RegExp(`/#seat=${code}\\.`));
  expect(newToken).not.toBe(boToken);

  // The old seat's socket is closed 4401 and its page says the link is no longer valid; opening the old link again
  // is refused the same way.
  await expect.poll(() => bo!.page.evaluate(() => (window as unknown as { __wsCloseCodes: number[] }).__wsCloseCodes)).toContain(4401);
  await expect(bo!.page.getByText('This seat link is no longer valid.')).toBeVisible();
  const oldLink = await bo!.page.context().newPage();
  await oldLink.goto(`/#seat=${code}.${boToken}`);
  await expect(oldLink.getByText('This seat link is no longer valid.')).toBeVisible();

  // The new link takes seat 2 (index 1) in a fresh browser.
  const bo2 = await player(browser, harness.baseURL);
  await bo2.page.goto(`/#seat=${code}.${newToken}`);
  await expect(bo2.page.locator('#app')).toHaveAttribute('data-seat', '1');
  await expect(bo2.page.locator('#app')).toHaveAttribute('data-lifecycle', 'active');

  // The host's credentials are untouched and its session still acts: it places its starting settlement.
  expect(await storedToken(ann.page, code)).toBe(hostToken);
  await expect(ann.page.locator('#app')).toHaveAttribute('data-seat', '0');
  const seq = Number(await ann.page.locator('#app').getAttribute('data-seq'));
  await ann.page.locator('[data-target-vertex]').filter({ visible: true }).first().click();
  await ann.page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect.poll(async () => Number(await ann.page.locator('#app').getAttribute('data-seq'))).toBeGreaterThan(seq);
  await expect(bo2.page.locator('#app')).toHaveAttribute('data-seq', String(seq + 1));

  for (const p of [ann!, cy!, bo2]) expect(p.errors).toEqual([]);
});
