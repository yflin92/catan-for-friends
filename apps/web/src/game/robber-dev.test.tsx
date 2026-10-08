// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, LegalActions } from '@hexlands/engine';
import { EMPTY_SNAPSHOT } from '../store';
import { wireViewFixture } from '../testing/view-fixture';
import type { PlayerViewWire, RoomView } from '../wire';
import { GameScreen, type GameActions } from './GameScreen';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const room = {
  lifecycle: 'active',
  hostSeat: 0,
  seats: [
    { seat: 0, name: 'Ann', connected: true },
    { seat: 1, name: 'Bo', connected: true },
    { seat: 2, name: 'Cy', connected: true },
  ],
} as unknown as RoomView;

const NONE: Partial<LegalActions> = {
  placeSettlement: [],
  placeRoad: [],
  buildCity: [],
  moveRobber: [],
  rollDice: false,
  endTurn: false,
  buyDevCard: false,
  playKnight: false,
  playRoadBuilding: false,
  playYearOfPlenty: [],
  playMonopoly: false,
  discard: null,
};

function viewWith(legal: Partial<LegalActions>, extra: Record<string, unknown> = {}): PlayerViewWire {
  const base = wireViewFixture([]);
  return { ...base, ...extra, legal: { ...base.legal, ...NONE, ...legal } } as PlayerViewWire;
}

let container: HTMLDivElement;
let root: Root;
let sent: Action[];
let actions: GameActions;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  sent = [];
  actions = { act: vi.fn(async (a: Action) => (sent.push(a), { actionId: 'a', result: 'ok' as const })) };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const render = (view: PlayerViewWire) =>
  act(() => root.render(<GameScreen snapshot={{ ...EMPTY_SNAPSHOT, room, view }} view={view} actions={actions} />));
const btn = (text: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(text) || b.getAttribute('aria-label') === text);
async function click(el: Element | undefined | null) {
  if (el === undefined || el === null) throw new Error('missing element');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('discard (AC9)', () => {
  it('chooses exactly legal.discard.count cards from the hand before Discard is enabled', async () => {
    render(viewWith({ phase: 'discard', discard: { count: 2 } }, { hand: { brick: 2, lumber: 0, wool: 1, grain: 1, ore: 0 } }));
    const discard = () => btn('Discard')!;
    expect(discard().disabled).toBe(true);
    expect(container.querySelector('[data-resource="lumber"]')).toBeNull();
    await click(btn('One more brick'));
    await click(btn('One more brick'));
    expect(btn('One more brick')!.disabled).toBe(true);
    expect(btn('One more wool')!.disabled).toBe(true);
    expect(discard().disabled).toBe(false);
    await click(discard());
    expect(sent).toEqual([{ type: 'discard', cards: { brick: 2, lumber: 0, wool: 0, grain: 0, ore: 0 } }]);
  });

  it('other seats see who still owes discards', () => {
    const base = wireViewFixture([]);
    const players = base.players.map((p) => (p.seat === 2 ? { ...p, discardOwed: 4 } : p));
    render(viewWith({ phase: 'discard', discard: null }, { players, phase: { name: 'discard', owed: [0, 0, 4], then: 'moveRobber' } }));
    expect(container.textContent).toContain('Waiting for discards: Cy (4)');
    expect(btn('Discard')).toBeUndefined();
  });
});

describe('robber (AC10)', () => {
  const hexes = wireViewFixture([]).board.hexes.map((h) => h.id);

  it('picks a hex from legal.moveRobber, then a victim from that hex’s list', async () => {
    render(viewWith({ phase: 'moveRobber', moveRobber: [{ hex: hexes[3]!, victims: [0, 2] }, { hex: hexes[4]!, victims: [] }] }));
    expect([...container.querySelectorAll('[data-target-hex]')].map((e) => e.getAttribute('data-target-hex'))).toEqual([hexes[3], hexes[4]]);
    await click(container.querySelector(`[data-target-hex="${hexes[3]}"]`));
    const dialog = container.querySelector('[aria-label="Choose who to rob"]')!;
    expect([...dialog.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Ann', 'Cy', 'Cancel']);
    expect(container.textContent).not.toMatch(/nobody/i);
    await click(btn('Cy'));
    expect(sent).toEqual([{ type: 'moveRobber', hex: hexes[3], victim: 2 }]);
  });

  it('offers "no victim" only when the hex has no victims, with a confirmation', async () => {
    render(viewWith({ phase: 'moveRobber', moveRobber: [{ hex: hexes[4]!, victims: [] }] }));
    await click(container.querySelector(`[data-target-hex="${hexes[4]}"]`));
    expect(container.querySelector('[role="dialog"]')?.textContent).toMatch(/Nobody there can be robbed/);
    await click(btn('Confirm'));
    expect(sent).toEqual([{ type: 'moveRobber', hex: hexes[4], victim: null }]);
  });

  it('shows the steal result, with the card type only when the detailed entry is visible', () => {
    const stoleDetail = { n: 7, event: { kind: 'stoleDetail', seat: 1, victim: 0, resource: 'ore' }, visibleTo: [0, 1] };
    render(viewWith({ phase: 'main' }, { log: [stoleDetail] }));
    expect(container.querySelector('[data-testid="steal"]')?.textContent).toBe('You stole 1 ore from Ann.');
    const stole = { n: 8, event: { kind: 'stole', seat: 0, victim: 2 }, visibleTo: 'all' };
    render(viewWith({ phase: 'main' }, { log: [stole] }));
    expect(container.querySelector('[data-testid="steal"]')?.textContent).toBe('Ann stole a card from Cy.');
  });
});

describe('road building', () => {
  it('offers free road picks from legal.placeRoad and shows how many are left', async () => {
    const roads = wireViewFixture([]).legal.placeRoad;
    render(viewWith({ phase: 'roadBuilding', placeRoad: roads }, { phase: { name: 'roadBuilding', remaining: 1, resume: 'main' } }));
    expect(container.textContent).toContain('Place a free road (1 left).');
    expect(container.querySelectorAll('[data-target-edge]').length).toBe(roads.length);
    await click(container.querySelector('[data-target-edge]'));
    await click(btn('Confirm'));
    expect(sent).toEqual([{ type: 'placeRoad', edge: roads[0] }]);
  });
});

describe('development cards (AC12–AC14)', () => {
  const devCards = [
    { kind: 'knight', playableNow: true },
    { kind: 'victoryPoint', playableNow: false },
    { kind: 'yearOfPlenty', playableNow: true },
    { kind: 'monopoly', playableNow: true },
    { kind: 'roadBuilding', playableNow: false },
  ];

  it('lists the hand; play buttons follow view.legal; VP cards are never playable', () => {
    render(viewWith({ phase: 'main', playKnight: true, playRoadBuilding: false, playMonopoly: true }, { devCards }));
    expect(container.querySelector('[data-dev-card="victoryPoint"]')?.textContent).toContain('Victory Point × 1');
    expect(container.querySelector('[data-dev-card="victoryPoint"] button')).toBeNull();
    expect(btn('Play Knight')!.disabled).toBe(false);
    expect(btn('Play Road Building')!.disabled).toBe(true);
    expect(btn('Play Year of Plenty')!.disabled).toBe(true);
    expect(btn('Play Monopoly')!.disabled).toBe(false);
  });

  it('buys and plays Knight, Road Building, Year of Plenty (legal pairs only) and Monopoly', async () => {
    render(
      viewWith(
        {
          phase: 'main',
          buyDevCard: true,
          playKnight: true,
          playRoadBuilding: true,
          playMonopoly: true,
          playYearOfPlenty: [
            ['grain', 'grain'],
            ['brick', 'ore'],
          ],
        },
        { devCards: devCards.map((c) => ({ ...c, playableNow: true })) },
      ),
    );
    await click(btn('Buy development card'));
    await click(btn('Play Knight'));
    await click(btn('Play Road Building'));
    await click(btn('Play Year of Plenty'));
    const yop = container.querySelector('[aria-label="Year of Plenty"]')!;
    expect([...yop.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['2 grain', 'brick + ore', 'Cancel']);
    await click(btn('brick + ore'));
    await click(btn('Play Monopoly'));
    await click(btn('Wool'));
    expect(sent).toEqual([
      { type: 'buyDevCard' },
      { type: 'playKnight' },
      { type: 'playRoadBuilding' },
      { type: 'playYearOfPlenty', take: ['brick', 'ore'] },
      { type: 'playMonopoly', resource: 'wool' },
    ]);
  });
});
