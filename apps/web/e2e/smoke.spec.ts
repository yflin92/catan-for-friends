import { expect, test } from './harness';
import type { Page } from '@playwright/test';

const TH15 = ['data-seq', 'data-view-hash', 'data-public-hash', 'data-lifecycle', 'data-seat'] as const;
const TOKEN = 'abcDEF0123456789_-abcDEF0123456789_-abcDEF0';

test('the app root carries the TH15 attributes', async ({ page }) => {
  const cspViolations: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error' && /Content Security Policy/i.test(m.text())) cspViolations.push(m.text());
  });
  await page.goto('/');
  const root = page.locator('#app');
  await expect(root).toBeVisible();
  for (const attr of TH15) {
    expect(await root.getAttribute(attr), attr).not.toBeNull();
  }
  expect(cspViolations).toEqual([]);
});

test('the harness server is reachable through the same-origin proxy', async ({ harness, request }) => {
  expect(harness.server.port).toBeGreaterThan(0);
  const res = await request.get('/api/does-not-exist');
  expect(res.status()).toBe(404);
});

test('a seat link moves its secret into localStorage and strips the fragment', async ({ page }) => {
  const sent: string[] = [];
  page.on('request', (r) => sent.push(r.url(), r.headers()['referer'] ?? ''));
  await page.goto(`/#seat=ABCDEF.${TOKEN}`);
  await expect(page.locator('#app')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  const stored = await page.evaluate(() => window.localStorage.getItem('hexlands.seat.ABCDEF'));
  expect(JSON.parse(stored ?? 'null')).toEqual({ roomCode: 'ABCDEF', seatToken: TOKEN });
  for (const s of sent) {
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain('ABCDEF');
  }
});

test('a join link stores the room code and strips the fragment', async ({ page }) => {
  await page.goto('/#join=GHJ-KMN');
  await expect(page.locator('#app')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  const stored = await page.evaluate(() => window.localStorage.getItem('hexlands.seat.GHJKMN'));
  expect(JSON.parse(stored ?? 'null')).toEqual({ roomCode: 'GHJKMN' });
});

async function expectSeatStored(page: Page, code: string, token: string): Promise<void> {
  await expect
    .poll(() => page.evaluate((k) => window.localStorage.getItem(k), `hexlands.seat.${code}`))
    .toBe(JSON.stringify({ roomCode: code, seatToken: token }));
}

test('a seat link opened in an already-loaded tab is stored and stripped, leaving no history entry', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
  const before = await page.evaluate(() => window.history.length);

  // Same-document navigation: assigning the hash fires hashchange without a reload.
  await page.evaluate((t) => {
    window.location.hash = `#seat=ABCDEF.${t}`;
  }, TOKEN);
  await expectSeatStored(page, 'ABCDEF', TOKEN);
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
  expect(page.url()).not.toContain(TOKEN);

  // The navigation added one entry, which replaceState rewrote; walk every entry and check none carries the token.
  const length = await page.evaluate(() => window.history.length);
  expect(length).toBe(before + 1);
  const urls: string[] = [];
  for (let i = 0; i < length - 1; i++) {
    await page.goBack({ waitUntil: 'commit' }).catch(() => null);
    urls.push(await page.evaluate(() => window.location.href));
  }
  for (let i = 0; i < length - 1; i++) {
    await page.goForward({ waitUntil: 'commit' }).catch(() => null);
    urls.push(await page.evaluate(() => window.location.href));
  }
  for (const u of urls) expect(u).not.toContain(TOKEN);
});

test('a join link opened via an in-page anchor in a loaded tab is stored and stripped', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.href = '#join=PQR-STU';
    document.body.append(a);
    a.click();
    a.remove();
  });
  await expect
    .poll(() => page.evaluate(() => window.localStorage.getItem('hexlands.seat.PQRSTU')))
    .toBe(JSON.stringify({ roomCode: 'PQRSTU' }));
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('');
});

test('a seat link opens the room socket at /ws and sends the token only inside hello', async ({ page }) => {
  const wsPromise = page.waitForEvent('websocket');
  await page.goto(`/#seat=ABCDEF.${TOKEN}`);
  const ws = await wsPromise;
  const hello = await ws.waitForEvent('framesent');
  expect(new URL(ws.url()).pathname).toBe('/ws');
  expect(ws.url()).not.toContain(TOKEN);
  expect(ws.url()).not.toContain('ABCDEF');
  expect(JSON.parse(String(hello.payload))).toMatchObject({ t: 'hello', v: 1, roomCode: 'ABCDEF', seatToken: TOKEN });
});
