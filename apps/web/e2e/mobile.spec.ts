// X-mobile (AC31 Q3 slice, ADR-0012 "desktop-first, usable on phones"): three players, the host on a 390×844 touch
// phone viewport and two on desktop. The host creates the room and starts on the phone; the game starts from the 3-player
// V15 golden eight commands before its end, and the browsers play those commands through the UI to finished, the phone
// tapping its own controls. On the phone, at every step: no horizontal page scroll; the board pans (drag) and zooms
// (pinch, buttons) and fits again; a placement's confirmation is a bottom sheet anchored to the viewport's bottom edge;
// the lobby's seat-order buttons are 44 px wide on the phone and their own width on a desktop screen. Every page ends
// on the win screen with lifecycle finished and no console errors. A second game, seeded with a discard owed by the
// phone, checks that the Discard and "Choose who to rob" dialogs are bottom sheets too and work by touch. Runs on
// Chromium (PR job) and WebKit (nightly); Firefox has no mobile emulation.
import { devices, type Browser, type BrowserContextOptions, type Page } from '@playwright/test';
import { STANDARD_TOPOLOGY, type GameState } from '@hexlands/engine';
import { buildState } from '@hexlands/engine/testing';
import { golden, goldenPrefix, perform } from './golden';
import { expect, isEngineConsoleError, startHarness, test as base, type Harness } from './harness';

const NAMES = ['Ann', 'Bo', 'Cy'] as const;
const TAIL = 8;
const PHONE: BrowserContextOptions = { ...devices['iPhone 13'], viewport: { width: 390, height: 844 } };

const scenario: { initial: ((created: GameState) => GameState) | undefined } = { initial: undefined };
const g = golden(3);

const test = base.extend<object, { mobile: Harness & { close(): Promise<void> } }>({
  mobile: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require an object pattern
    async ({}, use) => {
      process.env['HEXLANDS_TEST_HOOKS'] = '1';
      const h = await startHarness({
        config: { rooms: { failedCodeAttemptsPerIpPerMin: 10_000 } },
        testHooks: { seedFor: () => ({ seed: g.init.seed }), initialState: (_roomCode, created) => scenario.initial?.(created) },
      });
      await use(h);
      await h.close();
    },
    { scope: 'worker' },
  ],
});

/**
 * A bottom sheet: entirely inside the 390×844 viewport, its bottom edge on the viewport's bottom edge, and still there
 * after the page scrolls (it does not move with the document).
 */
async function bottomSheet(page: Page, selector: string): Promise<void> {
  const check = async (where: string) => {
    const r = (await page.locator(selector).boundingBox())!;
    expect(r.x, where).toBeGreaterThanOrEqual(0);
    expect(r.x + r.width, where).toBeLessThanOrEqual(390);
    expect(r.y, where).toBeGreaterThanOrEqual(0);
    expect(Math.abs(r.y + r.height - 844), `${where}: sheet bottom on the viewport's bottom edge`).toBeLessThanOrEqual(1);
  };
  await page.evaluate(() => window.scrollTo(0, 0));
  await check('page at the top');
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await page.evaluate(() => window.scrollY), 'the page scrolls under the sheet').toBeGreaterThan(0);
  await check('page scrolled to the end');
}

async function open(browser: Browser, baseURL: string, options: BrowserContextOptions = {}): Promise<{ page: Page; errors: string[] }> {
  const page = await (await browser.newContext({ ...options, baseURL })).newPage();
  const errors: string[] = [];
  const engine = browser.browserType().name();
  page.on('console', (m) => {
    if (m.type() === 'error' && !isEngineConsoleError(engine, m.text())) errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  return { page, errors };
}

/** No horizontal page scroll: the document is no wider than the viewport. */
async function fitsWidth(page: Page, where: string): Promise<void> {
  const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
  expect(scroll, `horizontal scroll on the phone (${where})`).toBeLessThanOrEqual(client);
}

const viewBox = async (page: Page) => ((await page.locator('svg.board-svg').getAttribute('viewBox')) ?? '').split(' ').map(Number) as [number, number, number, number];

/** Two synthetic pointers on the board moving apart: the pinch-zoom path of the board's pan/zoom. */
async function pinchOut(page: Page): Promise<void> {
  const box = (await page.locator('svg.board-svg').boundingBox())!;
  const [cx, cy] = [box.x + box.width / 2, box.y + box.height / 2];
  await page.locator('svg.board-svg').evaluate((svg, { x, y }) => {
    const fire = (type: string, id: number, px: number) =>
      svg.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: px, clientY: y, bubbles: true, pointerType: 'touch', isPrimary: id === 1 }));
    fire('pointerdown', 1, x - 40);
    fire('pointerdown', 2, x + 40);
    fire('pointermove', 2, x + 120);
    fire('pointerup', 2, x + 120);
    fire('pointerup', 1, x - 40);
  }, { x: cx, y: cy });
}

test.describe('X-mobile: a phone at 390×844 plays a game to finished', () => {
  test.use({ actionTimeout: 10_000 });

  test('3 players, the host on a phone: usable layout, board pan/zoom, dialogs fit, game to finished', async ({ browser, browserName, mobile }) => {
    test.skip(browserName === 'firefox', 'Firefox has no mobile emulation (isMobile).');
    const prefix = g.steps.slice(0, -TAIL);
    scenario.initial = goldenPrefix(g, prefix);
    const phone = await open(browser, mobile.baseURL, PHONE);
    const desks = [await open(browser, mobile.baseURL), await open(browser, mobile.baseURL)];
    const ph = phone.page;

    await ph.goto('/');
    await fitsWidth(ph, 'home');
    await ph.locator('input[name="hostName"]').fill(NAMES[0]);
    await ph.getByRole('button', { name: 'Create game' }).tap();
    const code = (await ph.locator('input[name="invite"]').inputValue()).split('#join=')[1]!;
    for (const [i, d] of desks.entries()) {
      await d.page.goto(`/#join=${code}`);
      await d.page.locator('input[name="displayName"]').fill(NAMES[i + 1]!);
      await d.page.getByRole('button', { name: 'Join', exact: true }).click();
      await expect(d.page.locator('[data-roster-seat] .tag', { hasText: 'you' })).toBeVisible();
    }
    await fitsWidth(ph, 'lobby');
    // The host's seat-order buttons are 44 px touch targets on the phone and keep their own width on a desktop screen.
    const up = ph.getByRole('button', { name: 'Move seat 2 up' });
    expect((await up.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    await ph.setViewportSize({ width: 1280, height: 800 });
    expect((await up.boundingBox())!.width).toBeLessThan(44);
    await ph.setViewportSize({ width: 390, height: 844 });
    await ph.getByRole('button', { name: 'Start game' }).tap();
    const all = [ph, ...desks.map((d) => d.page)];
    for (const p of all) await expect(p.locator('#app')).toHaveAttribute('data-lifecycle', 'active');
    await fitsWidth(ph, 'game');

    // The board zooms (buttons, pinch), pans (drag) and fits again.
    const fit = await viewBox(ph);
    await ph.getByRole('button', { name: 'Zoom in' }).tap();
    await expect.poll(async () => (await viewBox(ph))[2]).toBeLessThan(fit[2]);
    const zoomed = await viewBox(ph);
    const box = (await ph.locator('svg.board-svg').boundingBox())!;
    await ph.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await ph.mouse.down();
    await ph.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 60, { steps: 5 });
    await ph.mouse.up();
    await expect.poll(async () => (await viewBox(ph)).slice(0, 2)).not.toEqual(zoomed.slice(0, 2));
    await ph.getByRole('button', { name: 'Fit board' }).tap();
    await expect.poll(() => viewBox(ph)).toEqual(fit);
    await pinchOut(ph);
    await expect.poll(async () => (await viewBox(ph))[2]).toBeLessThan(fit[2]);
    await ph.getByRole('button', { name: 'Fit board' }).tap();
    await expect.poll(() => viewBox(ph)).toEqual(fit);

    let seq = 0;
    for (const step of g.steps.slice(-TAIL)) {
      const { by, action } = step.command;
      if (by === 0 && action.type === 'placeSettlement') {
        // On the phone the confirmation is a sheet inside the viewport, right after the tap on the board.
        await ph.locator('.builds button', { hasText: 'Settlement' }).tap();
        await ph.locator(`[data-target-vertex="${action.vertex}"]`).tap();
        await bottomSheet(ph, '[role="dialog"][aria-label="Confirm"]');
        await fitsWidth(ph, 'confirm sheet');
        await ph.getByRole('button', { name: 'Confirm', exact: true }).tap();
      } else {
        await perform(all, step.command, NAMES, new Set([ph]));
      }
      seq += 1;
      for (const p of all) await expect(p.locator('#app')).toHaveAttribute('data-seq', String(seq));
      expect(mobile.server.stateHash(code)).toEqual({ seq, stateHash: step.stateHash });
      await fitsWidth(ph, `seq ${seq}`);
    }

    for (const p of all) {
      await expect(p.locator('#app')).toHaveAttribute('data-lifecycle', 'finished');
      await expect(p.getByTestId('win-screen')).toBeVisible();
    }
    await fitsWidth(ph, 'win screen');
    for (const [i, c] of [phone, ...desks].entries()) expect(c.errors, `console errors in client ${i}`).toEqual([]);
  });

  test('the phone discards and moves the robber through bottom sheets that fit the screen', async ({ browser, browserName, mobile }) => {
    test.skip(browserName === 'firefox', 'Firefox has no mobile emulation (isMobile).');
    // The phone (seat 0, active) owes 4 of 8 cards after a 7; seat 1 has a settlement and a card, so it can be robbed.
    const victim = STANDARD_TOPOLOGY.hexCorners(STANDARD_TOPOLOGY.hexes[9]!)[0]!;
    scenario.initial = (c) =>
      buildState({
        board: c.board,
        playerCount: 3,
        pieces: [{ seat: 1, settlements: [victim], roads: [STANDARD_TOPOLOGY.vertexEdges(victim)[0]!] }],
        phase: { name: 'discard', owed: [4, 0, 0], then: 'moveRobber' },
        turn: { number: 3, active: 0, dice: [3, 4], devPlayed: false },
        hands: { 0: { brick: 4, ore: 4 }, 1: { wool: 1 } },
      });
    const phone = await open(browser, mobile.baseURL, PHONE);
    const desks = [await open(browser, mobile.baseURL), await open(browser, mobile.baseURL)];
    const ph = phone.page;
    await ph.goto('/');
    await ph.locator('input[name="hostName"]').fill(NAMES[0]);
    await ph.getByRole('button', { name: 'Create game' }).tap();
    const code = (await ph.locator('input[name="invite"]').inputValue()).split('#join=')[1]!;
    for (const [i, d] of desks.entries()) {
      await d.page.goto(`/#join=${code}`);
      await d.page.locator('input[name="displayName"]').fill(NAMES[i + 1]!);
      await d.page.getByRole('button', { name: 'Join', exact: true }).click();
      await expect(d.page.locator('[data-roster-seat] .tag', { hasText: 'you' })).toBeVisible();
    }
    await ph.getByRole('button', { name: 'Start game' }).tap();
    await expect(ph.locator('#app')).toHaveAttribute('data-lifecycle', 'active');

    const discard = ph.locator('[role="dialog"][aria-label="Discard"]');
    await expect(discard).toBeVisible();
    await bottomSheet(ph, '[role="dialog"][aria-label="Discard"]');
    await fitsWidth(ph, 'discard sheet');
    for (let i = 0; i < 4; i++) await discard.getByRole('button', { name: 'One more brick' }).tap();
    await discard.getByRole('button', { name: 'Discard', exact: true }).tap();
    await expect(ph.locator('#app')).toHaveAttribute('data-seq', '1');

    // Robber: a hex next to seat 1's settlement asks who to rob, in a sheet that fits.
    const near = STANDARD_TOPOLOGY.vertexHexes(victim).map((h) => `[data-target-hex="${h}"]`).join(', ');
    await ph.locator(near).first().tap();
    const rob = ph.locator('[role="dialog"][aria-label="Choose who to rob"]');
    await expect(rob).toBeVisible();
    await bottomSheet(ph, '[role="dialog"][aria-label="Choose who to rob"]');
    await fitsWidth(ph, 'robber sheet');
    await rob.getByRole('button', { name: NAMES[1] }).tap();
    await expect(ph.locator('#app')).toHaveAttribute('data-seq', '2');
    await expect(ph.getByRole('button', { name: 'End turn', exact: true })).toBeVisible();
    for (const [i, c] of [phone, ...desks].entries()) expect(c.errors, `console errors in client ${i}`).toEqual([]);
  });
});
