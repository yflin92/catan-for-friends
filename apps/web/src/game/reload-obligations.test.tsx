// After a reload the client holds nothing but the welcome view, so every pending obligation must render from the
// view alone (AC23): preRoll, an open offer, a discard owed, robber placement, and Road Building partway through.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LegalActions } from '@hexlands/engine';
import { App } from '../app';
import { EMPTY_SNAPSHOT, Store } from '../store';
import { wireViewFixture } from '../testing/view-fixture';
import type { PlayerViewWire, RoomView } from '../wire';

const room = {
  lifecycle: 'active',
  hostSeat: 0,
  seats: [
    { seat: 0, name: 'Ann', connected: true },
    { seat: 1, name: 'Bo', connected: true },
    { seat: 2, name: 'Cy', connected: true },
  ],
  waitingOn: [],
} as unknown as RoomView;
const rc = (c: Record<string, number> = {}) => ({ brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0, ...c });
const NONE: Partial<LegalActions> = { placeSettlement: [], placeRoad: [], buildCity: [], moveRobber: [], rollDice: false, endTurn: false, discard: null, proposeTrade: false };

function fresh(legal: Partial<LegalActions>, extra: Record<string, unknown> = {}): string {
  const base = wireViewFixture([]);
  const view = { ...base, ...extra, legal: { ...base.legal, ...NONE, ...legal } } as PlayerViewWire;
  const store = new Store({ ...EMPTY_SNAPSHOT, roomCode: 'ABCDEF', room, view, seq: 12, seat: 1 });
  return renderToStaticMarkup(<App store={store} />);
}

describe('a freshly loaded tab re-renders every pending obligation from the view', () => {
  const hexes = wireViewFixture([]).board.hexes.map((h) => h.id);
  const roads = wireViewFixture([]).legal.placeRoad;

  it('preRoll: the roll button', () => {
    expect(fresh({ phase: 'preRoll', rollDice: true }, { phase: { name: 'preRoll' } })).toContain('>Roll dice</button>');
  });

  it('main with an open offer: accept/decline for a non-active seat', () => {
    const trade = { id: 3, from: 0, give: rc({ brick: 1 }), get: rc({ wool: 1 }), responses: ['self', 'pending', 'pending'] };
    const html = fresh({ phase: 'main', respondTrade: { tradeId: 3, canAccept: true } }, { trade, turn: { ...wireViewFixture([]).turn, active: 0 } });
    expect(html).toContain('Ann offers');
    expect(html).toContain('>Accept</button>');
    expect(html).toContain('>Decline</button>');
  });

  it('a discard owed: the discard dialog with the count', () => {
    expect(fresh({ phase: 'discard', discard: { count: 4 } }, { phase: { name: 'discard', owed: [0, 4, 0], then: 'moveRobber' } })).toContain('Discard 4 cards');
  });

  it('robber placement: hex targets from legal.moveRobber', () => {
    const html = fresh({ phase: 'moveRobber', moveRobber: [{ hex: hexes[2]!, victims: [] }] }, { phase: { name: 'moveRobber', resume: 'main' } });
    expect(html).toContain(`data-target-hex="${hexes[2]}"`);
  });

  it('Road Building partway: free road targets and the remaining count', () => {
    const html = fresh({ phase: 'roadBuilding', placeRoad: roads }, { phase: { name: 'roadBuilding', remaining: 1, resume: 'main' } });
    expect(html).toContain('Place a free road (1 left).');
    expect(html).toContain('data-target-edge=');
  });
});
