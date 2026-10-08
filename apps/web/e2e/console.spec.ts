// No console errors on load, including after the client has parsed server frames (zod must not probe eval under the
// CSP: bug b8305b6748a6fc96151b2440).
import { expect, test } from './harness';

const TOKEN = 'abcDEF0123456789_-abcDEF0123456789_-abcDEF0';

test('loading the app logs no console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/');
  await expect(page.locator('#app')).toBeVisible();
  expect(errors).toEqual([]);
});

test('parsing server frames logs no console errors (no eval probe under the CSP)', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  const wsPromise = page.waitForEvent('websocket');
  await page.goto(`/#seat=ABCDEF.${TOKEN}`);
  const ws = await wsPromise;
  // The server answers the hello for an unknown room with an outcome frame, which the client parses.
  await ws.waitForEvent('framereceived');
  await expect(page.locator('[data-notice]')).toBeVisible();
  expect(errors).toEqual([]);
});
