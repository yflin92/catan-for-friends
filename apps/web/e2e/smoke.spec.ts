import { expect, test } from './harness';

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
