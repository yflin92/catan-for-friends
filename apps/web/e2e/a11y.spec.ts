// Accessibility pass (C-A11Y): axe-core over the home and lobby screens and the game page in the states a player meets
// (setup placement, the main phase with a trade offer open, the discard dialog, robber hex and victim choice, a
// development-card dialog, the win screen with its reveal, and the reconnecting and expired notices). The bar is no
// `serious` or `critical` violation; moderate and minor findings are printed for the record.
import AxeBuilder from '@axe-core/playwright';
import { test as base, expect, type Browser, type Page, type WebSocketRoute } from '@playwright/test';
import { STANDARD_TOPOLOGY, type GameState, type HexId } from '@hexlands/engine';
import { buildState } from '@hexlands/engine/testing';
import { FakeClock } from '@hexlands/server/testing';
import { startHarness, type Harness } from './harness';

/** The seq-0 state the next `start` uses, built from the created one; undefined keeps the created (setup) state. */
const scenario: { initial: ((created: GameState) => GameState) | undefined } = { initial: undefined };

const test = base.extend<object, { harness: Harness }>({
  harness: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require an object pattern
    async ({}, use) => {
      // testHooks (the injected start state) are honoured only with the test-hook gate on (design D2).
      const saved = process.env['HEXLANDS_TEST_HOOKS'];
      process.env['HEXLANDS_TEST_HOOKS'] = '1';
      // Every test creates a room from the same address; the per-IP create limit (6 per hour) is raised for the suite.
      const h = await startHarness({
        config: { rooms: { failedCodeAttemptsPerIpPerMin: 10_000, createsPerIpPerHour: 1_000 } },
        testHooks: { initialState: (_code, created) => scenario.initial?.(created) },
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

const NAMES = ['Ana', 'Bo', 'Cy'] as const;

/** Serious and critical violations on the page as it is now; moderate and minor ones are printed. */
async function scan(page: Page, label: string): Promise<string[]> {
  const result = await new AxeBuilder({ page }).analyze();
  const blocking: string[] = [];
  for (const v of result.violations) {
    const line = `${label}: [${v.impact}] ${v.id} (${v.nodes.length}) ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`;
    if (v.impact === 'serious' || v.impact === 'critical') blocking.push(line);
    else console.log(line);
  }
  return blocking;
}

async function open(browser: Browser, baseURL: string): Promise<Page> {
  return (await browser.newContext({ baseURL })).newPage();
}

/**
 * Creates a room through the UI and seats three players; `start` false leaves it in the lobby. `prepare` runs on each
 * page before it loads; `vpTarget` is set in the lobby before the start.
 */
async function room(
  browser: Browser,
  baseURL: string,
  opts: { start?: boolean; vpTarget?: number; prepare?: (page: Page, seat: number) => Promise<void> } = {},
): Promise<{ pages: Page[]; code: string }> {
  const pages = [await open(browser, baseURL), await open(browser, baseURL), await open(browser, baseURL)];
  for (const [i, p] of pages.entries()) await opts.prepare?.(p, i);
  const host = pages[0]!;
  await host.goto('/');
  await host.locator('input[name="hostName"]').fill(NAMES[0]);
  await host.getByRole('button', { name: 'Create game' }).click();
  const code = (await host.locator('input[name="invite"]').inputValue()).split('#join=')[1]!;
  for (let i = 1; i < 3; i++) {
    const p = pages[i]!;
    await p.goto(`/#join=${code}`);
    await p.locator('input[name="displayName"]').fill(NAMES[i]!);
    await p.getByRole('button', { name: 'Join' }).click();
    await expect(p.locator('[data-roster-seat] .tag', { hasText: 'you' })).toBeVisible();
  }
  if (opts.vpTarget !== undefined) {
    await host.locator('input[name="vpTarget"]').fill(String(opts.vpTarget));
    await host.getByRole('button', { name: 'Apply settings' }).click();
    await expect(pages[1]!.locator('input[name="vpTarget"]')).toHaveValue(String(opts.vpTarget));
  }
  if (opts.start !== false) {
    await host.getByRole('button', { name: 'Start game' }).click();
    for (const p of pages) await expect(p.locator('#app')).toHaveAttribute('data-lifecycle', 'active');
  }
  return { pages, code };
}

/** A main-phase state for seat 0 on the created board; `extra` overrides the spec. */
function mainState(created: GameState, extra: Parameters<typeof buildState>[0] = {}): GameState {
  return buildState({ playerCount: 3, board: created.board, turn: { number: 3, active: 0 }, phase: { name: 'main' }, ...extra });
}

test.beforeEach(() => {
  scenario.initial = undefined;
});

test('home and lobby (host, joiner) have no serious or critical violations', async ({ browser, harness }) => {
  const home = await open(browser, harness.baseURL);
  await home.goto('/');
  const issues = await scan(home, 'home');
  const { pages } = await room(browser, harness.baseURL, { start: false });
  issues.push(...(await scan(pages[0]!, 'lobby host')), ...(await scan(pages[1]!, 'lobby joiner')));
  expect(issues).toEqual([]);
});

test('home with the room-creation passphrase field has no serious or critical violations', async ({ browser }) => {
  const h = await startHarness({ config: { rooms: { createPassphrase: 'open sesame' } } });
  try {
    const page = await open(browser, h.baseURL);
    await page.goto('/');
    await page.locator('input[name="hostName"]').fill('Ana');
    await page.getByRole('button', { name: 'Create game' }).click();
    await expect(page.locator('input[name="passphrase"]')).toBeVisible();
    expect(await scan(page, 'home + passphrase')).toEqual([]);
  } finally {
    await h.close();
  }
});

test('setup placement has no serious or critical violations', async ({ browser, harness }) => {
  const { pages } = await room(browser, harness.baseURL);
  await expect(pages[0]!.locator('[data-target-vertex]').first()).toBeVisible();
  expect([...(await scan(pages[0]!, 'setup (placing)')), ...(await scan(pages[1]!, 'setup (waiting)'))]).toEqual([]);
});

test('main phase with a trade offer open has no serious or critical violations', async ({ browser, harness }) => {
  scenario.initial = (created) => mainState(created, { hands: { 0: { brick: 2, lumber: 1 }, 1: { wool: 2 }, 2: { grain: 1 } } });
  const { pages } = await room(browser, harness.baseURL);
  const host = pages[0]!;
  await host.locator('input[name="You give-brick"]').fill('1');
  await host.locator('input[name="You get-wool"]').fill('1');
  await host.getByRole('button', { name: 'Offer to players' }).click();
  await expect(pages[1]!.getByRole('button', { name: 'Decline' })).toBeVisible();
  expect([...(await scan(host, 'trade (proposer)')), ...(await scan(pages[1]!, 'trade (responder)'))]).toEqual([]);
});

test('the discard dialog has no serious or critical violations', async ({ browser, harness }) => {
  scenario.initial = (created) =>
    mainState(created, {
      hands: { 0: { brick: 4, ore: 4 }, 1: { wool: 2 } },
      phase: { name: 'discard', owed: [4, 0, 0], then: 'moveRobber' },
    });
  const { pages } = await room(browser, harness.baseURL);
  await expect(pages[0]!.getByRole('dialog', { name: 'Discard' })).toBeVisible();
  expect(await scan(pages[0]!, 'discard')).toEqual([]);
});

test('robber hex and victim choice have no serious or critical violations', async ({ browser, harness }) => {
  let target: HexId | undefined;
  scenario.initial = (created) => {
    const desert = created.board.hexes.find((h) => h.terrain === 'desert')!.id;
    target = created.board.hexes.find((h) => h.terrain !== 'desert')!.id;
    const corner = STANDARD_TOPOLOGY.hexCorners(target)[0]!;
    return mainState(created, {
      robber: desert,
      pieces: [{ seat: 1, settlements: [corner] }],
      hands: { 1: { wool: 2 } },
      phase: { name: 'moveRobber', resume: 'main' },
    });
  };
  const { pages } = await room(browser, harness.baseURL);
  const host = pages[0]!;
  await expect(host.locator('[data-target-hex]').first()).toBeVisible();
  const issues = await scan(host, 'robber (hex)');
  await host.locator(`[data-target-hex="${target!}"]`).click();
  await expect(host.getByRole('dialog', { name: 'Choose who to rob' })).toBeVisible();
  issues.push(...(await scan(host, 'robber (victim)')));
  expect(issues).toEqual([]);
});

test('a development-card dialog (Year of Plenty) has no serious or critical violations', async ({ browser, harness }) => {
  scenario.initial = (created) => mainState(created, { devCards: { 0: [{ kind: 'yearOfPlenty', boughtOnTurn: 1 }] } });
  const { pages } = await room(browser, harness.baseURL);
  await pages[0]!.getByRole('button', { name: 'Play Year of Plenty' }).click();
  await expect(pages[0]!.getByRole('dialog', { name: 'Year of Plenty' })).toBeVisible();
  expect(await scan(pages[0]!, 'year of plenty')).toEqual([]);
});

test('the win screen and reveal have no serious or critical violations', async ({ browser, harness }) => {
  // Seat 0 holds four victory-point cards with vpTarget 5 (set in the lobby); buying the deck's last card (a fifth) wins.
  scenario.initial = (created) =>
    mainState(created, {
      rules: { vpTarget: 5 },
      hands: { 0: { wool: 1, grain: 1, ore: 1 } },
      devCards: { 0: Array.from({ length: 4 }, () => ({ kind: 'victoryPoint' as const, boughtOnTurn: 1 })) },
    });
  const { pages } = await room(browser, harness.baseURL, { vpTarget: 5 });
  await pages[0]!.getByRole('button', { name: /Buy development card/ }).click();
  await expect(pages[0]!.getByTestId('win-screen')).toBeVisible();
  await expect(pages[1]!.getByTestId('win-screen')).toBeVisible();
  expect([...(await scan(pages[0]!, 'win (winner)')), ...(await scan(pages[1]!, 'win (other)'))]).toEqual([]);
});

test('the reconnecting notice has no serious or critical violations', async ({ browser, harness }) => {
  // Seat 1's socket runs through a route: once cut, the socket closes (1001) and every reconnect attempt is refused, so
  // the page stays in the reconnecting state.
  let cut = false;
  let socket: WebSocketRoute | null = null;
  const { pages } = await room(browser, harness.baseURL, {
    prepare: async (page, seat) => {
      if (seat !== 1) return;
      await page.routeWebSocket(/\/ws$/, (ws) => {
        if (cut) return void ws.close({ code: 1001 });
        ws.connectToServer();
        socket = ws;
      });
    },
  });
  const page = pages[1]!;
  cut = true;
  await (socket as WebSocketRoute | null)!.close({ code: 1001 });
  await expect(page.locator('[data-notice="reconnecting"]')).toBeVisible();
  expect(await scan(page, 'reconnecting')).toEqual([]);
});

test('the expired notice has no serious or critical violations', async ({ browser }) => {
  const clock = new FakeClock(Date.UTC(2026, 0, 1));
  const saved = process.env['HEXLANDS_TEST_HOOKS'];
  process.env['HEXLANDS_TEST_HOOKS'] = '1';
  const h = await startHarness({
    clock,
    config: { rooms: { failedCodeAttemptsPerIpPerMin: 10_000 }, lifecycle: { allDisconnectedAbandonMin: 1, resumeWindowDays: 1, checkIntervalSec: 3600 } },
  });
  if (saved === undefined) delete process.env['HEXLANDS_TEST_HOOKS'];
  else process.env['HEXLANDS_TEST_HOOKS'] = saved;
  try {
    const { pages, code } = await room(browser, h.baseURL);
    const { seatToken } = await pages[0]!.evaluate((c) => JSON.parse(localStorage.getItem(`hexlands.seat.${c}`)!) as { seatToken: string }, code);
    const context = pages[0]!.context();
    for (const p of pages) await p.close();
    await expect
      .poll(() => {
        clock.advance(24 * 3_600_000 + 60_000);
        h.server.runAbandonmentJob();
        return h.server.stateHash(code);
      })
      .toBeNull();
    const page = await context.newPage();
    await page.goto(`/#seat=${code}.${seatToken}`);
    await expect(page.getByText('This game has expired.')).toBeVisible();
    expect(await scan(page, 'expired')).toEqual([]);
  } finally {
    await h.close();
  }
});
