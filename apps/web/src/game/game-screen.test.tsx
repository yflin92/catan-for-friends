// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action, LegalActions } from '@hexlands/engine';
import type { OutcomeRecord } from '@hexlands/protocol';
import { EMPTY_SNAPSHOT, type StoreSnapshot } from '../store';
import { wireViewFixture } from '../testing/view-fixture';
import type { PlayerViewWire, RoomView } from '../wire';
import { GameScreen, type GameActions } from './GameScreen';
import { shortfall } from './turn-model';

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

const NO_LEGAL: Partial<LegalActions> = { placeSettlement: [], placeRoad: [], buildCity: [], moveRobber: [], rollDice: false, endTurn: false };

function viewWith(legal: Partial<LegalActions>, extra: Partial<PlayerViewWire> = {}): PlayerViewWire {
  const base = wireViewFixture([]);
  return { ...base, ...extra, legal: { ...base.legal, ...NO_LEGAL, ...legal } };
}

let container: HTMLDivElement;
let root: Root;
let sent: Action[];
let outcome: OutcomeRecord;
let actions: GameActions;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  sent = [];
  outcome = { actionId: 'a', result: 'ok', seq: 2 };
  actions = {
    act: vi.fn(async (a: Action) => {
      sent.push(a);
      return outcome;
    }),
  };
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render(view: PlayerViewWire, snap: Partial<StoreSnapshot> = {}) {
  act(() => root.render(<GameScreen snapshot={{ ...EMPTY_SNAPSHOT, room, view, ...snap }} view={view} actions={actions} />));
}
const targets = (kind: 'vertex' | 'edge' | 'hex') =>
  [...container.querySelectorAll(`[data-target-${kind}]`)].map((e) => e.getAttribute(`data-target-${kind}`));
const btn = (name: string) => [...container.querySelectorAll('button')].find((b) => b.textContent?.startsWith(name));
async function click(el: Element | undefined) {
  if (el === undefined) throw new Error('missing element');
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await Promise.resolve();
  });
}

describe('setup placements', () => {
  it('offers exactly the legal settlement corners, asks for confirmation, then sends placeSettlement', async () => {
    const base = wireViewFixture([]);
    const corners = base.legal.placeSettlement;
    render(viewWith({ phase: 'setupSettlement', placeSettlement: corners }, { phase: { name: 'setupSettlement', round: 1 } }));
    expect(container.textContent).toContain('Place your starting settlement.');
    expect(targets('vertex')).toEqual([...corners]);
    await click(container.querySelector(`[data-target-vertex="${corners[1]}"]`)!);
    const dialog = container.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toMatch(/^Place a settlement at the corner /);
    expect(dialog.textContent).not.toMatch(/v:-?\d/);
    expect(targets('vertex')).toEqual([]);
    await click(btn('Cancel'));
    expect(sent).toEqual([]);
    await click(container.querySelector(`[data-target-vertex="${corners[1]}"]`)!);
    await click(btn('Confirm'));
    expect(sent).toEqual([{ type: 'placeSettlement', vertex: corners[1] }]);
  });

  it('then offers the legal roads', async () => {
    const roads = wireViewFixture([]).legal.placeRoad;
    render(viewWith({ phase: 'setupRoad', placeRoad: roads }));
    expect(container.textContent).toContain('Place a road next to your new settlement.');
    expect(targets('edge')).toEqual([...roads]);
    await click(container.querySelector(`[data-target-edge="${roads[0]}"]`)!);
    await click(btn('Confirm'));
    expect(sent).toEqual([{ type: 'placeRoad', edge: roads[0] }]);
  });
});

describe('turn actions', () => {
  it('rolls only when legal.rollDice, and shows the last roll with this seat’s gains', async () => {
    render(viewWith({ phase: 'preRoll', rollDice: false }));
    expect(btn('Roll dice')).toBeUndefined();
    const gains = [
      { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 },
      { brick: 1, lumber: 0, wool: 0, grain: 2, ore: 0 },
      { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 },
    ];
    const log = [{ n: 5, event: { kind: 'diceRolled', seat: 1, dice: [3, 4], gains, shortage: [], auto: false }, visibleTo: 'all' }];
    render(viewWith({ phase: 'preRoll', rollDice: true }, { log } as unknown as Partial<PlayerViewWire>));
    expect(container.querySelector('[data-testid="dice"]')?.textContent).toBe('Rolled 3 + 4 = 7 · you got 1 brick, 2 grain');
    await click(btn('Roll dice'));
    expect(sent).toEqual([{ type: 'rollDice' }]);
  });

  it('enables each build only when view.legal lists places for it, with costs and display-only shortfalls', async () => {
    const base = wireViewFixture([]);
    render(viewWith({ phase: 'main', placeRoad: base.legal.placeRoad, buildCity: base.legal.buildCity, endTurn: true }));
    const road = btn('Road')!;
    const settlement = btn('Settlement')!;
    const city = btn('City')!;
    expect(road.disabled).toBe(false);
    expect(settlement.disabled).toBe(true);
    expect(settlement.textContent).toContain('needs 1 lumber, 1 grain');
    expect(city.disabled).toBe(false);
    expect(road.textContent).toContain('1 brick, 1 lumber');
    expect(targets('edge')).toEqual([]);
    await click(road);
    expect(targets('edge')).toEqual([...base.legal.placeRoad]);
    await click(city);
    expect(targets('edge')).toEqual([]);
    expect(targets('vertex')).toEqual([...base.legal.buildCity]);
    await click(container.querySelector('[data-target-vertex]')!);
    expect(container.querySelector('[role="dialog"]')?.textContent).toMatch(/^Upgrade to a city/);
    await click(btn('Confirm'));
    expect(sent).toEqual([{ type: 'buildCity', vertex: base.legal.buildCity[0] }]);
    await click(btn('End turn'));
    expect(sent[1]).toEqual({ type: 'endTurn' });
  });

  it('shows a rejection as friendly text and keeps the view unchanged', async () => {
    const roads = wireViewFixture([]).legal.placeRoad;
    outcome = { actionId: 'a', result: 'rule', reasonCode: 'not_connected' };
    render(viewWith({ phase: 'setupRoad', placeRoad: roads }));
    await click(container.querySelector('[data-target-edge]')!);
    await click(btn('Confirm'));
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('That spot isn’t connected to your roads.');
    expect(targets('edge')).toEqual([...roads]);
  });

  it('while an action is pending, shows a waiting state and offers nothing', () => {
    const roads = wireViewFixture([]).legal.placeRoad;
    const pending = new Map([['a', { actionId: 'a', msg: {}, sentAt: 0 }]]);
    render(viewWith({ phase: 'main', placeRoad: roads, endTurn: true }), { pending });
    expect(container.textContent).toContain('Waiting for the server…');
    expect(btn('End turn')?.disabled).toBe(true);
    expect(btn('Road')?.disabled).toBe(true);
    expect(targets('edge')).toEqual([]);
  });

  it('when it is another seat’s turn, names who is playing and shows no builds', () => {
    const v = viewWith({ phase: 'main', seat: 1 });
    render({ ...v, turn: { ...v.turn, active: 2 } });
    expect(container.querySelector('[data-testid="turn-status"]')?.textContent).toBe('Waiting for Cy (Seat 3)…');
    expect(btn('Road')).toBeUndefined();
  });
});

describe('shortfall', () => {
  it('lists only what the hand is missing', () => {
    expect(shortfall({ grain: 2, ore: 3 }, { brick: 0, lumber: 0, wool: 0, grain: 2, ore: 1 })).toBe('needs 2 ore');
    expect(shortfall({ brick: 1 }, { brick: 1, lumber: 0, wool: 0, grain: 0, ore: 0 })).toBeNull();
  });
});
