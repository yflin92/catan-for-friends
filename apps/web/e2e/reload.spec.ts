// AC23 reload timing harness (C-8): for each of 5 pending sub-states, reload the obligated seat's tab repeatedly. After
// every reload the tab must show the same view (data-view-hash, data-seq) and the server state must be unchanged
// (RunningServer.stateHash); p95 < 5 s and every reload < 10 s, reported in the test output. Where a sub-state defines
// it, the reloaded tab then finishes the obligation and the turn goes on. Players come from the harness ContextPool,
// so each test's browser contexts are closed when it ends.
// HEXLANDS_RELOADS sets the reloads per sub-state: 1 on every PR run, 20 in the nightly workflow (AC23 DoD 5 × 20).
import type { Page } from '@playwright/test';
import { STANDARD_TOPOLOGY, type GameState, type Seat } from '@hexlands/engine';
import { buildState } from '@hexlands/engine/testing';
import { expect, startHarness, test as base, type ContextPool, type Harness } from './harness';

const RELOADS = Number(process.env['HEXLANDS_RELOADS'] ?? 1);
const P95_LIMIT_MS = 5_000;
const MAX_LIMIT_MS = 10_000;

interface SubState {
  readonly name: string;
  /** The seat whose tab is reloaded: the one with the pending obligation. */
  readonly seat: Seat;
  readonly state: (created: GameState) => GameState;
  /** After the reloads, finishes the obligation through the UI of the reloaded tab and asserts the turn goes on. */
  readonly complete?: (page: Page) => Promise<void>;
}

const MAIN = { number: 3, active: 0 as Seat, dice: [3, 4] as const, devPlayed: false };
/** The north corner of the centre hex: a land vertex on every board. */
const RB_SETTLEMENT = STANDARD_TOPOLOGY.hexCorners(STANDARD_TOPOLOGY.hexes[9]!)[0]!;
const rc = (c: Record<string, number> = {}) => ({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0, ...c });

const SUB_STATES: readonly SubState[] = [
  { name: 'preRoll', seat: 0, state: (c) => buildState({ board: c.board, playerCount: 3, phase: { name: 'preRoll' }, turn: { ...MAIN, dice: null } }) },
  {
    name: 'main with an open offer',
    seat: 1,
    state: (c) =>
      buildState({
        board: c.board,
        playerCount: 3,
        phase: { name: 'main' },
        turn: MAIN,
        hands: { 0: { brick: 2 }, 1: { wool: 2 } },
        trade: { id: 1, from: 0, give: rc({ brick: 1 }), get: rc({ wool: 1 }), responses: ['self', 'pending', 'pending'] },
      }),
  },
  {
    name: 'a discard owed',
    seat: 1,
    state: (c) =>
      buildState({
        board: c.board,
        playerCount: 3,
        phase: { name: 'discard', owed: [0, 4, 0], then: 'moveRobber' },
        turn: { ...MAIN, dice: [3, 4] },
        hands: { 1: { brick: 4, ore: 4 } },
      }),
  },
  { name: 'robber placement', seat: 0, state: (c) => buildState({ board: c.board, playerCount: 3, phase: { name: 'moveRobber', resume: 'main' }, turn: MAIN }) },
  {
    name: 'partway through Road Building',
    seat: 0,
    // Seat 0 has a settlement on a corner of the centre hex and one road from it, so its last free road has legal edges.
    state: (c) =>
      buildState({
        board: c.board,
        playerCount: 3,
        pieces: [{ seat: 0, settlements: [RB_SETTLEMENT], roads: [STANDARD_TOPOLOGY.vertexEdges(RB_SETTLEMENT)[0]!] }],
        phase: { name: 'roadBuilding', remaining: 1, resume: 'main' },
        turn: MAIN,
      }),
    complete: async (page) => {
      const root = page.locator('#app');
      // A vertical edge target has a zero-width geometry box, which Playwright treats as hidden; the others are used.
      await page.locator('[data-target-edge]').filter({ visible: true }).first().click();
      await page.getByRole('button', { name: 'Confirm', exact: true }).click();
      await expect(root).toHaveAttribute('data-seq', '1');
      await page.getByRole('button', { name: 'End turn', exact: true }).click();
      await expect(root).toHaveAttribute('data-seq', '2');
      await expect(page.getByTestId('turn-status')).toHaveText(/^Waiting for /);
    },
  },
];

/** The sub-state each room starts in, keyed by room code; read by testHooks.initialState at game start. */
const PENDING = new Map<string, SubState>();

const test = base.extend<object, { reloadHarness: Harness & { close(): Promise<void> } }>({
  reloadHarness: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures require an object pattern
    async ({}, use) => {
      process.env['HEXLANDS_TEST_HOOKS'] = '1';
      const h = await startHarness({
        config: { rooms: { failedCodeAttemptsPerIpPerMin: 10_000 } },
        testHooks: { initialState: (roomCode, created) => PENDING.get(roomCode)?.state(created) },
      });
      await use(h);
      await h.close();
    },
    { scope: 'worker' },
  ],
});

/** Creates a room and seats three players through the UI, one context each from `pool`; one page per seat. */
async function seatThree(pool: ContextPool, baseURL: string): Promise<{ code: string; pages: Page[] }> {
  const pages: Page[] = [];
  for (let i = 0; i < 3; i++) pages.push(await pool.page(baseURL));
  const [host, ...guests] = pages as [Page, Page, Page];
  await host.goto('/');
  await host.getByLabel('Your name').first().fill('Ann');
  await host.getByRole('button', { name: 'Create game' }).click();
  const invite = await host.locator('input[name="invite"]').inputValue();
  const code = invite.split('#join=')[1]!;
  for (const [i, g] of guests.entries()) {
    await g.goto('/');
    await g.locator('input[name="roomCode"]').fill(code);
    await g.locator('input[name="joinName"]').fill(['Bo', 'Cy'][i]!);
    await g.getByRole('button', { name: 'Join' }).click();
    await expect(g.locator('[data-roster-seat] .tag', { hasText: 'you' })).toBeVisible();
  }
  return { code, pages };
}

function percentile(xs: readonly number[], p: number): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0;
}

test.describe('AC23: reload mid-turn restores the same view (5 sub-states × reloads)', () => {
  for (const sub of SUB_STATES) {
    test(`${sub.name}: ${RELOADS} reloads`, async ({ pages: pool, reloadHarness }) => {
      const { code, pages } = await seatThree(pool, reloadHarness.baseURL);
      PENDING.set(code, sub);
      await pages[0]!.getByRole('button', { name: 'Start game' }).click();

      const page = pages[sub.seat]!;
      const root = page.locator('#app');
      await expect(root).toHaveAttribute('data-seq', '0');
      const viewHash = await root.getAttribute('data-view-hash');
      const serverBefore = reloadHarness.server.stateHash(code);
      expect(viewHash).toMatch(/^[0-9a-f]{64}$/);
      expect(serverBefore).not.toBeNull();

      const times: number[] = [];
      for (let i = 0; i < RELOADS; i++) {
        const t0 = Date.now();
        await page.reload();
        await expect(root).toHaveAttribute('data-view-hash', viewHash!, { timeout: MAX_LIMIT_MS });
        times.push(Date.now() - t0);
        await expect(root).toHaveAttribute('data-seq', '0');
      }
      expect(reloadHarness.server.stateHash(code)).toEqual(serverBefore);

      const p95 = percentile(times, 95);
      const max = Math.max(...times);
      console.log(`[AC23] ${test.info().project.name} ${sub.name}: n=${times.length} p50=${percentile(times, 50)}ms p95=${p95}ms max=${max}ms`);
      expect(p95).toBeLessThan(P95_LIMIT_MS);
      expect(max).toBeLessThan(MAX_LIMIT_MS);
      await sub.complete?.(page);
    });
  }
});
