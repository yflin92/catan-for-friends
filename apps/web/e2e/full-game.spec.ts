// AC31 (C-9): independent browser contexts create and join a room and play through the UI only, in two runs.
// - Run 1 (organic): 4 browsers go lobby → setup draft → live turns until the game has covered a 7 (discard and robber),
//   a paid build, a player-to-player trade and a dev-card buy. A UI bot picks every action from the rendered controls.
// - Run 2 (seeded near-end, 4 and 3 players): testHooks.initialState starts the game from a V15 golden replayed up to
//   eight commands before its gameOver; the browsers then perform those eight commands through the UI, and after each
//   one the server's stateHash equals the golden's. Every client then shows lifecycle finished, the win screen and the
//   reveal.
// In both runs all clients show the same data-public-hash at every seq (TH13/TH15) with the board and the log rendered,
// every public log entry the server sent appears in every client's log panel, no outcome is internal_error, no page
// has a console error, and no received WebSocket frame carries hidden server data or another seat's token (V17).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Browser, Page } from '@playwright/test';
import { reduce, stateHash, type Command, type GameState } from '@hexlands/engine';
import { FakeClock } from '@hexlands/server';
import { expect, startHarness, test as base, type Harness } from './harness';

const MAX_STEPS = Number(process.env['HEXLANDS_AC31_MAX_STEPS'] ?? 1500);
const NAMES = ['Ann', 'Bo', 'Cy', 'Di'] as const;
/** Server data that must never reach a client frame (V17). Tokens are checked separately. */
const HIDDEN_KEYS = ['"devDeck"', '"rng"', '"seed"', '"streamSeeds"'];
/** Commands of the golden left for the browsers to perform. */
const TAIL = 8;

interface GoldenStep {
  readonly command: Command;
  readonly stateHash: string;
}
interface Golden {
  readonly init: { readonly seed: string; readonly playerCount: 3 | 4 };
  readonly initialStateHash: string;
  readonly steps: readonly GoldenStep[];
}
const golden = (players: 3 | 4): Golden =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`../../../packages/engine/src/__fixtures__/golden/v15-game-${players}p.json`, import.meta.url)), 'utf8'),
  ) as Golden;

/** What the next `start` uses: its seed and, for Run 2, the seq-0 state built from the created one. */
const scenario: { seed: string; initial: ((created: GameState) => GameState) | undefined } = { seed: 'ac31', initial: undefined };

const test = base.extend<object, { ac31: Harness & { close(): Promise<void> } }>({
  ac31: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require an object pattern
    async ({}, use) => {
      process.env['HEXLANDS_TEST_HOOKS'] = '1';
      const h = await startHarness({
        config: { rooms: { failedCodeAttemptsPerIpPerMin: 10_000 } },
        testHooks: {
          seedFor: () => ({ seed: scenario.seed }),
          initialState: (_roomCode, created) => scenario.initial?.(created),
        },
      });
      await use(h);
      await h.close();
    },
    { scope: 'worker' },
  ],
});

interface Client {
  readonly page: Page;
  readonly frames: string[];
  readonly errors: string[];
}

/**
 * Console errors raised by the browser engine itself, not by the app (known issue KI-1). Playwright's WebKit build
 * checks the user-agent styles of its own <select> controls against the page's CSP (no 'unsafe-inline' style-src) and
 * logs this for every <select> it renders; Chromium and Firefox do not. setUp asserts that the select still renders.
 */
const ENGINE_CONSOLE_ERRORS: Readonly<Record<string, readonly string[]>> = {
  webkit: ["Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' appears in neither the style-src directive nor the default-src directive of the Content Security Policy."],
};

async function openClient(browser: Browser, baseURL: string): Promise<Client> {
  const page = await (await browser.newContext({ baseURL })).newPage();
  const client: Client = { page, frames: [], errors: [] };
  const engineNoise = ENGINE_CONSOLE_ERRORS[browser.browserType().name()] ?? [];
  page.on('console', (m) => {
    if (m.type() === 'error' && !engineNoise.includes(m.text())) client.errors.push(m.text());
  });
  page.on('pageerror', (e) => client.errors.push(String(e)));
  page.on('websocket', (ws) => ws.on('framereceived', (f) => client.frames.push(String(f.payload))));
  return client;
}

/** Creates the room through the UI, seats everyone via the invite link and starts; returns the clients and room code. */
async function setUp(browser: Browser, baseURL: string, players: 3 | 4): Promise<{ clients: Client[]; code: string }> {
  const clients: Client[] = [];
  for (let i = 0; i < players; i++) clients.push(await openClient(browser, baseURL));
  const host = clients[0]!.page;
  await host.goto('/');
  await host.locator('input[name="hostName"]').fill(NAMES[0]);
  await host.getByRole('button', { name: 'Create game' }).click();
  const code = (await host.locator('input[name="invite"]').inputValue()).split('#join=')[1]!;
  if (browser.browserType().name() === 'webkit') {
    // KI-1: the ignored WebKit CSP message must not mean a broken control; the lobby's <select> renders its options.
    const select = host.locator('select[name="absenceMode"]');
    await expect(select).toBeVisible();
    expect(await select.locator('option').count()).toBeGreaterThan(0);
  }
  for (let i = 1; i < players; i++) {
    const p = clients[i]!.page;
    await p.goto(`/#join=${code}`);
    await p.locator('input[name="displayName"]').fill(NAMES[i]!);
    await p.getByRole('button', { name: 'Join' }).click();
    await expect(p.locator('[data-roster-seat] .tag', { hasText: 'you' })).toBeVisible();
  }
  await host.getByRole('button', { name: 'Start game' }).click();
  for (const c of clients) await expect(c.page.locator('#app')).toHaveAttribute('data-lifecycle', 'active');
  return { clients, code };
}

const seqOf = async (p: Page) => Number((await p.locator('#app').getAttribute('data-seq')) ?? '-1');

/** Waits until every client shows the same seq ≥ `atLeast`, then returns it. */
async function settle(clients: readonly Client[], atLeast: number): Promise<number> {
  let seq = -1;
  await expect
    .poll(async () => {
      const seqs = await Promise.all(clients.map((c) => seqOf(c.page)));
      seq = seqs[0]!;
      return seqs.every((s) => s === seqs[0]) && seqs[0]! >= atLeast;
    }, { timeout: 15_000 })
    .toBe(true);
  return seq;
}

/** All clients show one public projection hash at `seq`, and every page still renders the board and the log. */
async function samePublicHash(clients: readonly Client[], seq: number): Promise<void> {
  const hashes = await Promise.all(clients.map((c) => c.page.locator('#app').getAttribute('data-public-hash')));
  expect(new Set(hashes).size, `public hash diverged at seq ${seq}`).toBe(1);
  expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  for (const c of clients) {
    await expect(c.page.locator('[data-hex]').first()).toBeAttached();
    await expect(c.page.locator('section[aria-label="Game log"]')).toBeAttached();
  }
}

/** Log coverage, console errors and the V17 wire audit, over everything each client received. */
async function audit(clients: readonly Client[]): Promise<void> {
  for (const c of clients) {
    const publicNs = new Set<number>();
    for (const f of c.frames) {
      const msg = JSON.parse(f) as { view?: { log: { n: number; visibleTo: unknown }[] } | null };
      for (const e of msg.view?.log ?? []) if (e.visibleTo === 'all') publicNs.add(e.n);
    }
    expect(publicNs.size).toBeGreaterThan(0);
    const shown = new Set(await c.page.locator('[data-log-n]').evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-log-n')))));
    for (const n of publicNs) expect(shown.has(n), `log entry ${n} missing`).toBe(true);
  }
  const tokens = await Promise.all(
    clients.map((c) =>
      c.page.evaluate(() =>
        Object.keys(localStorage)
          .filter((k) => k.startsWith('hexlands.seat.'))
          .map((k) => (JSON.parse(localStorage.getItem(k)!) as { seatToken: string }).seatToken),
      ),
    ),
  );
  for (const [i, c] of clients.entries()) {
    expect(c.errors, `console errors in client ${i}`).toEqual([]);
    for (const f of c.frames) {
      expect(f).not.toContain('"internal_error"');
      for (const k of HIDDEN_KEYS) expect(f).not.toContain(k);
      for (const [j, own] of tokens.entries()) if (j !== i) for (const t of own) expect(f).not.toContain(t);
    }
  }
}

/** Event kinds seen in the log entries the clients received, plus 'built:paid' and 'trade:confirmed'. */
function covered(clients: readonly Client[]): Set<string> {
  const seen = new Set<string>();
  for (const c of clients) {
    for (const f of c.frames) {
      const msg = JSON.parse(f) as { view?: { log: { event: { kind: string; free?: boolean; outcome?: string } }[] } | null };
      for (const { event } of msg.view?.log ?? []) {
        seen.add(event.kind);
        if (event.kind === 'built' && event.free === false) seen.add('built:paid');
        if (event.kind === 'tradeResolved' && event.outcome === 'confirmed') seen.add('trade:confirmed');
      }
    }
  }
  return seen;
}

// ── Run 1: the UI bot ────────────────────────────────────────────────────────────────────────────────────────────────

const COST: Readonly<Record<'City' | 'Settlement', readonly string[]>> = {
  City: ['grain', 'ore'],
  Settlement: ['brick', 'lumber', 'wool', 'grain'],
};
const RESOURCE_WORDS = ['brick', 'lumber', 'wool', 'grain', 'ore'] as const;

/** Bot memory for one run: the pick sequence, rolls so far, the roll of this turn's offer, and whether to offer. */
const bot = { picks: 0, rolls: 0, offeredAtRoll: -1, wantTrade: true };
/** A fixed-sequence pick among `n` targets, so pieces spread over the board instead of piling on the first target. */
const pickIndex = (n: number) => (bot.picks = (bot.picks * 1103515245 + 12345) % 2 ** 31) % n;

async function handOf(page: Page): Promise<Record<string, number>> {
  const text = (await page.getByTestId('my-hand').textContent()) ?? '';
  return Object.fromEntries(RESOURCE_WORDS.map((r) => [r, Number(new RegExp(`(\\d+) ${r}`).exec(text)?.[1] ?? 0)]));
}

/**
 * Performs one UI action on `page` if it has one: obligations and trade replies first, then rolling, growth (city,
 * settlement, road, dev cards), one player offer per turn while wanted, a bank trade toward the goal, and finally ending
 * the turn. The goal is a city while the seat has a settlement to upgrade, else a settlement; a bank trade only gives a
 * resource the goal does not use. Returns false when the page has nothing to do now.
 */
async function act(page: Page): Promise<boolean> {
  const visible = async (sel: string) => (await page.locator(sel).filter({ visible: true }).count()) > 0;
  const button = (name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
  const enabled = async (name: string | RegExp) => (await button(name).count()) > 0 && (await button(name).first().isEnabled());
  // A vertical edge target has a zero-width geometry box, which Playwright treats as hidden; the others are picked from.
  const clickTarget = async (sel: string) => {
    const targets = page.locator(sel).filter({ visible: true });
    await targets.nth(pickIndex(await targets.count())).click();
  };
  if (await visible('[role="dialog"][aria-label="Discard"]')) {
    const dialog = page.locator('[role="dialog"][aria-label="Discard"]');
    while (!(await dialog.getByRole('button', { name: 'Discard', exact: true }).isEnabled())) {
      await dialog.locator('button[aria-label^="One more"]:not([disabled])').first().click();
    }
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    return true;
  }
  for (const dialog of ['Choose who to rob', 'Year of Plenty', 'Monopoly']) {
    if (await visible(`[aria-label="${dialog}"]`)) {
      await page.locator(`[aria-label="${dialog}"] button:not([disabled])`).first().click();
      return true;
    }
  }
  // Trade replies: accept when the hand allows, else decline. The proposer confirms the first partner once one
  // accepted, cancels once everyone answered without one, and waits otherwise.
  for (const reply of ['Accept', 'Decline']) {
    if (await enabled(reply)) {
      await button(reply).click();
      return true;
    }
  }
  if (await enabled(/^Trade with /)) {
    await button(/^Trade with /).first().click();
    return true;
  }
  if (await enabled('Cancel offer')) {
    if ((await page.locator('.offer .responses li', { hasText: 'pending' }).count()) > 0) return false;
    await button('Cancel offer').click();
    return true;
  }
  if (await visible('[data-target-vertex], [data-target-edge], [data-target-hex]')) {
    await clickTarget('[data-target-vertex], [data-target-edge], [data-target-hex]');
    // A placement or a robber hex without victims asks for confirmation; a robber hex with victims asks who to rob.
    const next = page.locator('[role="dialog"][aria-label="Confirm"], [aria-label="Choose who to rob"]').first();
    await next.waitFor();
    if ((await next.getAttribute('aria-label')) === 'Confirm') await button('Confirm').click();
    else await page.locator('[aria-label="Choose who to rob"] button').first().click();
    return true;
  }
  if (await enabled('Roll dice')) {
    await button('Roll dice').click();
    bot.rolls++;
    return true;
  }
  if (!(await visible('.builds'))) return false;
  for (const build of ['City', 'Settlement', 'Road']) {
    const b = page.locator('.builds button', { hasText: build }).first();
    if ((await b.count()) > 0 && (await b.isEnabled())) {
      if ((await b.getAttribute('aria-pressed')) !== 'true') await b.click();
      await clickTarget(build === 'Road' ? '[data-target-edge]' : '[data-target-vertex]');
      await button('Confirm').click();
      return true;
    }
  }
  const play = page.locator('.dev-cards button:not([disabled])', { hasText: /^Play / });
  if ((await play.count()) > 0) {
    await play.first().click();
    // Year of Plenty and Monopoly ask for a choice before anything is sent.
    const choice = page.locator('[aria-label="Year of Plenty"], [aria-label="Monopoly"]');
    if ((await choice.count()) > 0) await choice.locator('button:not([disabled])').first().click();
    return true;
  }
  if (await enabled(/^Buy development card/)) {
    await button(/^Buy development card/).click();
    return true;
  }
  if (bot.wantTrade && bot.offeredAtRoll !== bot.rolls && (await visible('form.composer'))) {
    const hand = await handOf(page);
    const give = RESOURCE_WORDS.reduce((a, b) => (hand[b]! > hand[a]! ? b : a));
    const get = RESOURCE_WORDS.find((r) => hand[r] === 0 && r !== give) ?? RESOURCE_WORDS.find((r) => r !== give)!;
    if (hand[give]! > 0) {
      bot.offeredAtRoll = bot.rolls;
      await page.locator(`input[name="You give-${give}"]`).fill('1');
      await page.locator(`input[name="You get-${get}"]`).fill('1');
      await button('Offer to players').click();
      return true;
    }
  }
  const seat = await page.locator('#app').getAttribute('data-seat');
  const goal = (await page.locator(`[data-settlement][data-seat="${seat}"]`).count()) > 0 ? 'City' : 'Settlement';
  const missing = (await page.locator('.builds button', { hasText: goal }).locator('.build-missing').textContent()) ?? '';
  const want = COST[goal].find((r) => missing.includes(r));
  if (want !== undefined && (await visible('form.maritime'))) {
    const gives = await page.locator('select[name="maritimeGive"] option').evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
    const give = gives.find((r) => !COST[goal].includes(r));
    const stock = (await page.locator(`select[name="maritimeReceive"] option[value="${want}"]`).textContent()) ?? '';
    if (give !== undefined && !stock.includes('bank has 0)')) {
      await page.locator('select[name="maritimeGive"]').selectOption(give);
      await page.locator('select[name="maritimeReceive"]').selectOption(want);
      await page.locator('form.maritime button[type="submit"]').click();
      return true;
    }
  }
  if (await enabled('End turn')) {
    await button('End turn').click();
    return true;
  }
  return false;
}

// ── Run 2: golden commands through the UI ────────────────────────────────────────────────────────────────────────────

/** Performs `cmd` through the controls of its seat's page; covers the command types the golden tails contain. */
async function perform(clients: readonly Client[], { by, action }: Command): Promise<void> {
  const page = clients[by as number]!.page;
  const button = (name: string | RegExp) => page.getByRole('button', { name, exact: typeof name === 'string' });
  const place = async (build: string, target: string) => {
    await page.locator('.builds button', { hasText: build }).click();
    await page.locator(target).click();
    await button('Confirm').click();
  };
  switch (action.type) {
    case 'rollDice':
      return button('Roll dice').click();
    case 'endTurn':
      return button('End turn').click();
    case 'proposeTrade':
      for (const [side, counts] of [['You give', action.give], ['You get', action.get]] as const) {
        for (const [r, n] of Object.entries(counts)) if (n > 0) await page.locator(`input[name="${side}-${r}"]`).fill(String(n));
      }
      return button('Offer to players').click();
    case 'respondTrade':
      return button(action.accept ? 'Accept' : 'Decline').click();
    case 'confirmTrade':
      return button(`Trade with ${NAMES[action.partner as number]}`).click();
    case 'placeSettlement':
      return place('Settlement', `[data-target-vertex="${action.vertex}"]`);
    case 'buildCity':
      return place('City', `[data-target-vertex="${action.vertex}"]`);
    case 'placeRoad':
      return place('Road', `[data-target-edge="${action.edge}"]`);
    default:
      throw new Error(`no UI driver for ${action.type}`);
  }
}

/** The golden's own commands replayed from the created state, checking each step's hash: reachable by construction. */
function goldenPrefix(g: Golden, steps: readonly GoldenStep[]): (created: GameState) => GameState {
  return (created) => {
    if (stateHash(created) !== g.initialStateHash) throw new Error('the created state differs from the golden init');
    return steps.reduce((s, step, i) => {
      const r = reduce(s, step.command);
      if (!r.ok || stateHash(r.state) !== step.stateHash) throw new Error(`golden step ${i} does not replay`);
      return r.state;
    }, created);
  };
}

test.describe('AC31: games through the UI', () => {
  test.use({ actionTimeout: 10_000 });

  test('run 1: 4 players, lobby → setup → a 7, a paid build, a player trade and a dev-card buy', async ({ browser, ac31 }) => {
    test.setTimeout(10 * 60_000);
    Object.assign(scenario, { seed: 'ac31-organic', initial: undefined });
    Object.assign(bot, { picks: 0, rolls: 0, offeredAtRoll: -1, wantTrade: true });
    const { clients } = await setUp(browser, ac31.baseURL, 4);
    const goals = ['discarded', 'robberMoved', 'built:paid', 'trade:confirmed', 'devBought'];
    let seq = await settle(clients, 0);
    for (let step = 0; step < MAX_STEPS; step++) {
      await samePublicHash(clients, seq);
      const seen = covered(clients);
      bot.wantTrade = !seen.has('trade:confirmed');
      if (goals.every((g) => seen.has(g))) break;
      let acted = false;
      for (const c of clients) {
        if (await act(c.page)) {
          acted = true;
          break;
        }
      }
      expect(acted, `no client had an action at seq ${seq}`).toBe(true);
      seq = await settle(clients, seq + 1);
    }
    const seen = covered(clients);
    for (const g of goals) expect(seen.has(g), `run 1 never covered ${g} (seq ${seq})`).toBe(true);
    await audit(clients);
  });

  for (const players of [4, 3] as const) {
    test(`run 2: ${players} players from a golden ${TAIL} commands before its end, through gameOver and the reveal`, async ({ browser, ac31 }) => {
      test.setTimeout(3 * 60_000);
      const g = golden(players);
      const prefix = g.steps.slice(0, -TAIL);
      Object.assign(scenario, { seed: g.init.seed, initial: goldenPrefix(g, prefix) });
      const { clients, code } = await setUp(browser, ac31.baseURL, players);
      expect(ac31.server.stateHash(code)).toEqual({ seq: 0, stateHash: prefix.at(-1)!.stateHash });
      let seq = await settle(clients, 0);
      for (const step of g.steps.slice(-TAIL)) {
        await samePublicHash(clients, seq);
        await perform(clients, step.command);
        seq = await settle(clients, seq + 1);
        expect(ac31.server.stateHash(code)).toEqual({ seq, stateHash: step.stateHash });
      }
      await samePublicHash(clients, seq);
      for (const c of clients) {
        await expect(c.page.locator('#app')).toHaveAttribute('data-lifecycle', 'finished');
        await expect(c.page.getByTestId('win-screen')).toBeVisible();
        await expect(c.page.getByTestId('turn-status')).toHaveText('The game is over.');
      }
      await audit(clients);
    });
  }
});

test.describe('AC29: rejoining an expired game', () => {
  test('a saved seat link to an expired, purged game shows that the game has expired', async ({ browser }) => {
    test.skip(true, 'Needs D26 tombstones (db176c912003567f2869d5ca, #61): a purged game answers unknown_room until then.');
    const clock = new FakeClock(Date.UTC(2026, 0, 1));
    process.env['HEXLANDS_TEST_HOOKS'] = '1';
    const h = await startHarness({
      clock,
      config: {
        rooms: { failedCodeAttemptsPerIpPerMin: 10_000 },
        lifecycle: { allDisconnectedAbandonMin: 1, resumeWindowDays: 1, checkIntervalSec: 3600 },
      },
    });
    try {
      const { clients, code } = await setUp(browser, h.baseURL, 3);
      const host = clients[0]!;
      const { seatToken } = await host.page.evaluate((c) => JSON.parse(localStorage.getItem(`hexlands.seat.${c}`)!) as { seatToken: string }, code);
      const context = host.page.context();
      for (const c of clients) await c.page.close();
      // Once the server has seen every seat leave, the job abandons the game, then expires and purges it after the
      // resume window; stateHash is null once it is purged.
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
    } finally {
      await h.close();
    }
  });
});
