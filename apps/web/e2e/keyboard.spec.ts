// Keyboard-only play (C-A11Y): every control is reached with Tab and used with Enter or Space, focus is always
// visible and never covered (on a phone the dialogs are bottom sheets), and every dialog takes focus when it opens,
// keeps Tab and Shift+Tab inside, closes on Escape when it can be cancelled and returns focus when it closes. One turn
// covers the roll (a scripted 7), another player's discard, the robber hex and victim, a trade, Year of Plenty, a road
// and End turn; it runs at desktop and phone size.
import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { STANDARD_TOPOLOGY, type GameState, type HexId } from '@hexlands/engine';
import { buildState } from '@hexlands/engine/testing';
import { contextPoolFixture, startHarness, type ContextPool, type Harness } from './harness';

/** The robber's target hex in the scripted state (seat 1 has a settlement on it). */
let target: HexId | undefined;

/**
 * Seat 0 is about to roll a scripted 7. Seat 1 holds 9 cards (owes 4) and a settlement on `target`; seat 0 has a
 * settlement and road on the same hex's opposite corner, cards for a trade and a road, and a playable Year of Plenty.
 */
function scripted(created: GameState): GameState {
  const hex = created.board.hexes.find((h) => h.terrain !== 'desert')!.id;
  target = hex;
  const corners = STANDARD_TOPOLOGY.hexCorners(hex);
  const mine = corners[3]!;
  return buildState({
    playerCount: 3,
    board: created.board,
    robber: created.board.hexes.find((h) => h.terrain === 'desert')!.id,
    pieces: [
      { seat: 0, settlements: [mine], roads: [STANDARD_TOPOLOGY.vertexEdges(mine)[0]!] },
      { seat: 1, settlements: [corners[0]!] },
    ],
    hands: { 0: { brick: 2, lumber: 1, grain: 1 }, 1: { brick: 3, wool: 3, grain: 3 }, 2: { ore: 1 } },
    devCards: { 0: [{ kind: 'yearOfPlenty', boughtOnTurn: 1 }] },
    turn: { number: 3, active: 0 },
    phase: { name: 'preRoll' },
    rng: { dice: { scripted: [3, 4] } },
  });
}

const test = base.extend<{ pages: ContextPool }, { harness: Harness }>({
  pages: contextPoolFixture,
  harness: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require an object pattern
    async ({}, use) => {
      // testHooks (the injected start state) are honoured only with the test-hook gate on (design D2).
      const saved = process.env['HEXLANDS_TEST_HOOKS'];
      process.env['HEXLANDS_TEST_HOOKS'] = '1';
      const h = await startHarness({
        // Every test creates rooms from the same address; the per-IP create limit (6 per hour) is raised for the suite.
        config: { rooms: { failedCodeAttemptsPerIpPerMin: 10_000, createsPerIpPerHour: 1_000 } },
        testHooks: { initialState: (_code, created) => scripted(created) },
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

const isFocused = (l: Locator) => l.evaluate((el) => el === document.activeElement);

/** A stable id for the focused element, to notice when a key press no longer moves focus. */
const focusMark = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { __focusIds?: WeakMap<Element, number>; __focusCount?: number };
    const e = document.activeElement;
    if (!e) return -1;
    w.__focusIds ??= new WeakMap();
    let id = w.__focusIds.get(e);
    if (id === undefined) {
      id = w.__focusCount = (w.__focusCount ?? 0) + 1;
      w.__focusIds.set(e, id);
    }
    return id;
  });

/**
 * Presses Tab until `target` has focus, then checks the focus is visible. Past the page's last control some engines
 * (Firefox) move focus into the browser's own UI instead of wrapping to the top; when Tab stops moving focus, the
 * search continues backwards with Shift+Tab, as a keyboard user would. Fails when the target is never reached.
 */
async function tabTo(page: Page, target: Locator, max = 250): Promise<void> {
  let key = 'Tab';
  let last = await focusMark(page);
  for (let i = 0; i < max; i++) {
    if (await isFocused(target)) {
      await expectFocusVisible(page);
      return;
    }
    await page.keyboard.press(key);
    const now = await focusMark(page);
    if (now === last) {
      if (key === 'Shift+Tab') break;
      key = 'Shift+Tab';
    }
    last = now;
  }
  throw new Error(`not reachable with Tab: ${String(target)}`);
}

/** Tab to `target`, then Enter. */
async function activate(page: Page, target: Locator): Promise<void> {
  await tabTo(page, target);
  await page.keyboard.press('Enter');
}

/**
 * The focused element shows a focus indicator (an outline, or the board target's thicker mark) and is on screen and
 * not covered by anything else, e.g. a bottom sheet.
 */
async function expectFocusVisible(page: Page): Promise<void> {
  // Polled: some engines scroll the newly focused element into view a frame after the key press.
  const issue = () => page.evaluate(() => {
    const el = document.activeElement;
    if (!(el instanceof Element) || el === document.body) return 'nothing focused';
    const target = el.closest('.target');
    if (target) {
      const mark = target.querySelector('.target-mark');
      if (!mark || getComputedStyle(mark).strokeWidth !== '10px') return 'board target without its focus mark';
      // Non-text contrast (WCAG 1.4.11): the focused mark against an unfocused target's mark, at least 3:1.
      const other = Array.from(document.querySelectorAll('.target')).find((t) => t !== target)?.querySelector('.target-mark');
      const lum = (rgb: string) => {
        const [r, g, b] = (rgb.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map((v) => {
          const c = Number(v) / 255;
          return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
      };
      if (other) {
        const [a, b] = [lum(getComputedStyle(mark).stroke), lum(getComputedStyle(other).stroke)];
        const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        if (ratio < 3) return `focused board target mark contrast ${ratio.toFixed(2)}:1 < 3:1`;
      }
    } else {
      const s = getComputedStyle(el);
      if (s.outlineStyle === 'none' || parseFloat(s.outlineWidth) < 2) return `no focus outline on ${el.tagName}`;
    }
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + Math.min(r.height / 2, 8);
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return `focused ${el.tagName} is off screen`;
    const hit = document.elementFromPoint(x, y);
    // A board target counts as covered only by something outside the board (e.g. a bottom sheet); overlapping board
    // shapes are not covers.
    const onBoard = target !== null && hit?.closest('svg.board-svg') === target.closest('svg.board-svg');
    if (!hit || !(el === hit || el.contains(hit) || onBoard)) {
      return `focused ${el.tagName} is covered by ${hit?.tagName ?? 'nothing'}.${hit?.className ?? ''}`;
    }
    return null;
  });
  await expect.poll(issue, { timeout: 2_000 }).toBeNull();
}

/**
 * The dialog has focus and Tab and Shift+Tab cycle inside it. At phone width (≤ 900 px) it is a fixed bottom sheet,
 * otherwise inline in the panel.
 */
async function expectDialogFocus(page: Page, dialog: Locator): Promise<void> {
  await expect(dialog).toBeVisible();
  const sheet = (page.viewportSize()?.width ?? 1280) <= 900;
  expect(await dialog.evaluate((d) => getComputedStyle(d).position)).toBe(sheet ? 'fixed' : 'static');
  const inside = () => dialog.evaluate((d) => d.contains(document.activeElement));
  await expect.poll(inside).toBe(true);
  for (const key of ['Tab', 'Shift+Tab']) {
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(key);
      expect(await inside(), `${key} left the dialog`).toBe(true);
    }
  }
  await expectFocusVisible(page);
}

/** Creates a room and seats three players; returns their pages, all on the started game. */
async function room(pages: ContextPool, baseURL: string, viewport: { width: number; height: number }): Promise<Page[]> {
  const players = [await pages.page(baseURL, { viewport }), await pages.page(baseURL, { viewport }), await pages.page(baseURL, { viewport })];
  const [host] = players as [Page];
  await host.goto('/');
  await host.locator('input[name="hostName"]').fill('Ana');
  await host.getByRole('button', { name: 'Create game' }).click();
  const code = (await host.locator('input[name="invite"]').inputValue()).split('#join=')[1]!;
  for (const [i, name] of ['Bo', 'Cy'].entries()) {
    const p = players[i + 1]!;
    await p.goto(`/#join=${code}`);
    await p.locator('input[name="displayName"]').fill(name);
    await p.getByRole('button', { name: 'Join' }).click();
    await expect(p.locator('[data-roster-seat] .tag', { hasText: 'you' })).toBeVisible();
  }
  await activate(host, host.getByRole('button', { name: 'Start game' }));
  for (const p of players) await expect(p.locator('#app')).toHaveAttribute('data-lifecycle', 'active');
  return players;
}

for (const [name, viewport] of [
  ['desktop', { width: 1280, height: 800 }],
  ['phone', { width: 390, height: 844 }],
] as const) {
  test(`${name}: a whole turn by keyboard only — roll, discard, robber, trade, Year of Plenty, road, end turn`, async ({ pages, harness }) => {
    test.setTimeout(120_000);
    const [ana, bo] = (await room(pages, harness.baseURL, viewport)) as [Page, Page, Page];

    // Roll: a scripted 7. Bo owes 4 cards; the discard dialog takes his focus and cannot be dismissed with Escape.
    await activate(ana, ana.getByRole('button', { name: 'Roll dice' }));
    const discard = bo.getByRole('dialog', { name: 'Discard' });
    await expectDialogFocus(bo, discard);
    await bo.keyboard.press('Escape');
    await expect(discard).toBeVisible();
    for (const r of ['brick', 'brick', 'brick', 'grain']) await activate(bo, discard.getByRole('button', { name: `One more ${r}` }));
    await activate(bo, discard.getByRole('button', { name: 'Discard', exact: true }));
    await expect(discard).toBeHidden();

    // Robber: a named hex target, then the victim dialog. Escape cancels and returns focus to the hex.
    const hex = ana.locator(`[data-target-hex="${target!}"]`);
    await expect(hex).toHaveAttribute('aria-label', /.+/);
    await activate(ana, hex);
    const rob = ana.getByRole('dialog', { name: 'Choose who to rob' });
    await expectDialogFocus(ana, rob);
    await ana.keyboard.press('Escape');
    await expect(rob).toBeHidden();
    expect(await isFocused(hex)).toBe(true);
    await ana.keyboard.press('Enter');
    await expectDialogFocus(ana, rob);
    await activate(ana, rob.getByRole('button', { name: 'Bo' }));
    await expect(rob).toBeHidden();

    // Trade: Ana offers 1 brick for 1 wool; Bo accepts; Ana confirms with Bo.
    await tabTo(ana, ana.locator('input[name="You give-brick"]'));
    await ana.keyboard.press('ArrowUp');
    await tabTo(ana, ana.locator('input[name="You get-wool"]'));
    await ana.keyboard.press('ArrowUp');
    await activate(ana, ana.getByRole('button', { name: 'Offer to players' }));
    await activate(bo, bo.getByRole('button', { name: 'Accept' }));
    await expect(ana.getByRole('button', { name: /Trade with Bo/ })).toBeEnabled();
    await activate(ana, ana.getByRole('button', { name: /Trade with Bo/ }));
    await expect(ana.getByRole('button', { name: /Trade with Bo/ })).toBeHidden();

    // Year of Plenty: the dialog takes focus; Escape closes it and returns focus to its button; then take two cards.
    const play = ana.getByRole('button', { name: 'Play Year of Plenty' });
    await activate(ana, play);
    const yop = ana.getByRole('dialog', { name: 'Year of Plenty' });
    await expectDialogFocus(ana, yop);
    await ana.keyboard.press('Escape');
    await expect(yop).toBeHidden();
    expect(await isFocused(play)).toBe(true);
    await ana.keyboard.press('Enter');
    await expectDialogFocus(ana, yop);
    await activate(ana, yop.getByRole('button', { name: '2 lumber' }));
    await expect(yop).toBeHidden();

    // A road: the Road button, a named edge target, then the confirm dialog. Once the edge is built, focus returns to
    // the game panel.
    await activate(ana, ana.getByRole('button', { name: /^Road/ }));
    const edge = ana.locator('[data-target-edge]').first();
    await expect(edge).toHaveAttribute('aria-label', /.+/);
    await activate(ana, edge);
    const confirm = ana.getByRole('dialog', { name: 'Confirm' });
    await expectDialogFocus(ana, confirm);
    await activate(ana, confirm.getByRole('button', { name: 'Confirm' }));
    await expect(confirm).toBeHidden();
    await expect.poll(() => ana.evaluate(() => document.activeElement?.classList.contains('game-panel') ?? false)).toBe(true);

    // End turn: Bo is next.
    await activate(ana, ana.getByRole('button', { name: 'End turn' }));
    await expect(bo.getByRole('button', { name: 'Roll dice' })).toBeVisible();
  });
}
