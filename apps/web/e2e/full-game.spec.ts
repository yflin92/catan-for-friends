// AC31 (C-9): N independent browser contexts create and join a room, then play a seeded game to `finished` using only
// the UI. At every seq all clients show the same data-public-hash (TH13/TH15); every public event appears in every
// client's log; no outcome is internal_error; no console errors; and no received WebSocket frame carries hidden
// server data (V17 wire audit). Runs for 4 and for 3 players.
//
// SKIPPED until its prerequisites are on main:
// - E-INT: the engine plays a complete game (every rule track integrated);
// - L-2: lobby ops over WS and ServerOptions.testHooks.seedFor applied at start;
// - S-6: welcome/resync with the full current view;
// - S-8: the abandonment job and lifecycle (finished) on the server.
import type { Browser, Page } from '@playwright/test';
import { expect, startHarness, test as base, type Harness } from './harness';

const MAX_STEPS = Number(process.env['HEXLANDS_AC31_MAX_STEPS'] ?? 4000);
const NAMES = ['Ann', 'Bo', 'Cy', 'Di'] as const;
/** Server data that must never reach a client frame (V17). Tokens are checked separately. */
const HIDDEN_KEYS = ['"devDeck"', '"rng"', '"seed"', '"streamSeeds"'];

const test = base.extend<object, { ac31: Harness & { close(): Promise<void> } }>({
  ac31: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require an object pattern
    async ({}, use) => {
      process.env['HEXLANDS_TEST_HOOKS'] = '1';
      const h = await startHarness({
        config: { rooms: { failedCodeAttemptsPerIpPerMin: 10_000 } },
        testHooks: { seedFor: (roomCode) => ({ seed: `ac31-${roomCode}` }) },
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

async function openClient(browser: Browser, baseURL: string): Promise<Client> {
  const page = await (await browser.newContext({ baseURL })).newPage();
  const client: Client = { page, frames: [], errors: [] };
  page.on('console', (m) => {
    if (m.type() === 'error') client.errors.push(m.text());
  });
  page.on('pageerror', (e) => client.errors.push(String(e)));
  page.on('websocket', (ws) => ws.on('framereceived', (f) => client.frames.push(String(f.payload))));
  return client;
}

/** Creates the room (host lowers the target to 5 points to keep the game short), seats everyone and starts. */
async function setUp(browser: Browser, baseURL: string, players: 3 | 4): Promise<Client[]> {
  const clients: Client[] = [];
  for (let i = 0; i < players; i++) clients.push(await openClient(browser, baseURL));
  const host = clients[0]!.page;
  await host.goto('/');
  await host.locator('input[name="hostName"]').fill(NAMES[0]);
  await host.getByRole('button', { name: 'Create game' }).click();
  const code = (await host.locator('input[name="invite"]').inputValue()).split('#join=')[1]!;
  for (let i = 1; i < players; i++) {
    const p = clients[i]!.page;
    await p.goto(`/#join=${code}`);
    await p.locator('input[name="displayName"]').fill(NAMES[i]!);
    await p.getByRole('button', { name: 'Join' }).click();
    await expect(p.locator('[data-roster-seat] .tag', { hasText: 'you' })).toBeVisible();
  }
  await host.locator('input[name="vpTarget"]').fill('5');
  await host.getByRole('button', { name: 'Apply settings' }).click();
  await expect(host.locator('input[name="vpTarget"]')).toHaveValue('5');
  await host.getByRole('button', { name: 'Start game' }).click();
  for (const c of clients) await expect(c.page.locator('#app')).toHaveAttribute('data-lifecycle', 'active');
  return clients;
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

/** Performs one UI action on `page` if it has one, preferring obligations, then growth, then ending the turn. */
async function act(page: Page): Promise<boolean> {
  const visible = async (sel: string) => (await page.locator(sel).count()) > 0 && (await page.locator(sel).first().isVisible());
  const enabled = async (name: string) => {
    const b = page.getByRole('button', { name, exact: true });
    return (await b.count()) > 0 && (await b.first().isEnabled());
  };
  if (await visible('[role="dialog"][aria-label="Discard"]')) {
    const dialog = page.locator('[role="dialog"][aria-label="Discard"]');
    while (!(await dialog.getByRole('button', { name: 'Discard', exact: true }).isEnabled())) {
      await dialog.locator('button[aria-label^="One more"]:not([disabled])').first().click();
    }
    await dialog.getByRole('button', { name: 'Discard', exact: true }).click();
    return true;
  }
  if (await visible('[aria-label="Choose who to rob"]')) {
    await page.locator('[aria-label="Choose who to rob"] button').first().click();
    return true;
  }
  if (await visible('[data-target-vertex], [data-target-edge], [data-target-hex]')) {
    await page.locator('[data-target-vertex], [data-target-edge], [data-target-hex]').first().click();
    if (await visible('[role="dialog"][aria-label="Confirm"]')) await page.getByRole('button', { name: 'Confirm', exact: true }).click();
    return true;
  }
  if (await enabled('Roll dice')) {
    await page.getByRole('button', { name: 'Roll dice', exact: true }).click();
    return true;
  }
  for (const build of ['City', 'Settlement', 'Road']) {
    const b = page.locator('.builds button', { hasText: build }).first();
    if ((await b.count()) > 0 && (await b.isEnabled())) {
      await b.click();
      if (await visible('[data-target-vertex], [data-target-edge]')) {
        await page.locator('[data-target-vertex], [data-target-edge]').first().click();
        await page.getByRole('button', { name: 'Confirm', exact: true }).click();
        return true;
      }
    }
  }
  if (await enabled('End turn')) {
    await page.getByRole('button', { name: 'End turn', exact: true }).click();
    return true;
  }
  return false;
}

test.describe('AC31: a full seeded game through the UI', () => {
  test.skip(true, 'Needs E-INT (complete engine), L-2 (lobby + testHooks.seedFor), S-6 (resync) and S-8 (lifecycle) on main.');
  test.setTimeout(30 * 60_000);

  for (const players of [4, 3] as const) {
    test(`${players} players play to finished with identical public projections at every seq`, async ({ browser, ac31 }) => {
      const clients = await setUp(browser, ac31.baseURL, players);
      let seq = await settle(clients, 0);
      for (let step = 0; step < MAX_STEPS; step++) {
        if ((await clients[0]!.page.locator('#app').getAttribute('data-lifecycle')) === 'finished') break;
        const hashes = await Promise.all(clients.map((c) => c.page.locator('#app').getAttribute('data-public-hash')));
        expect(new Set(hashes).size, `public hash diverged at seq ${seq}`).toBe(1);
        expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
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
      for (const c of clients) {
        await expect(c.page.locator('#app')).toHaveAttribute('data-lifecycle', 'finished');
        await expect(c.page.getByTestId('win-screen')).toBeVisible();
      }

      // Every public log entry the server sent appears in every client's log panel.
      for (const c of clients) {
        const publicNs = new Set<number>();
        for (const f of c.frames) {
          const msg = JSON.parse(f) as { t: string; view?: { log: { n: number; visibleTo: unknown }[] } | null };
          for (const e of msg.view?.log ?? []) if (e.visibleTo === 'all') publicNs.add(e.n);
        }
        const shown = new Set((await c.page.locator('[data-log-n]').evaluateAll((els) => els.map((el) => Number(el.getAttribute('data-log-n'))))));
        for (const n of publicNs) expect(shown.has(n), `log entry ${n} missing`).toBe(true);
      }

      // Outcomes, console and wire audit (NFR3, V17).
      const tokens = await Promise.all(
        clients.map((c) => c.page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('hexlands.seat.')).map((k) => JSON.parse(localStorage.getItem(k)!).seatToken as string))),
      );
      for (const [i, c] of clients.entries()) {
        expect(c.errors, `console errors in client ${i}`).toEqual([]);
        for (const f of c.frames) {
          expect(f).not.toContain('"internal_error"');
          for (const k of HIDDEN_KEYS) expect(f).not.toContain(k);
          for (const [j, own] of tokens.entries()) if (j !== i) for (const t of own) expect(f).not.toContain(t);
        }
      }
    });
  }
});
