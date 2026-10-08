import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { GameEvent } from './events';
import { canonicalJson, sha256Hex, stateHash } from './hash';
import type { Seat } from './ids';
import { legalActions } from './legal-actions';
import { emit } from './log';
import type { DevCardKind, GameState, Phase } from './state';
import { buildState } from './testing';
import { victoryPoints } from './victory';
import { LOG_WINDOW, PRIVATE_VIEW_KEYS, publicProjection, publicProjectionHash, publicProjectionHashOfState, view } from './view';

const SEATS = [0, 1, 2, 3] as const;
const withEvents = (s: GameState, events: readonly GameEvent[]): GameState => events.reduce(emit, s);

/** Seat 1 holds hidden cards; seat 0 robbed seat 1; seat 2 bought a card. */
function richState(phase: Phase = { name: 'main' }): GameState {
  const base = buildState({
    pieces: [
      { seat: 0, settlements: ['v:0,0,N'], cities: ['v:0,1,S'], roads: ['e:0,0,NE'] },
      { seat: 1, settlements: ['v:-1,-1,S'] },
    ],
    hands: { 0: { brick: 1, wool: 2 }, 1: { ore: 3, grain: 1 }, 2: { lumber: 4 } },
    devCards: { 0: [{ kind: 'victoryPoint', boughtOnTurn: 1 }], 1: [{ kind: 'monopoly', boughtOnTurn: 1 }, { kind: 'victoryPoint', boughtOnTurn: 2 }] },
    playedDev: { 2: { knight: 3 } },
    phase,
    allowInvariantViolations: phase.name === 'gameOver',
  });
  return withEvents(base, [
    { kind: 'stole', seat: 0, victim: 1 },
    { kind: 'stoleDetail', seat: 0, victim: 1, resource: 'ore' },
    { kind: 'devBought', seat: 2 },
    { kind: 'devBoughtDetail', seat: 2, card: 'knight' },
  ]);
}

describe('view(state, seat) (design §3.7)', () => {
  const s = richState();
  const v = view(s, 0);

  it('has exactly the §3.7 fields', () => {
    expect(Object.keys(v).sort()).toEqual(
      ['awards', 'bank', 'board', 'config', 'devCards', 'devDeckCount', 'hand', 'legal', 'log', 'phase', 'pieces', 'playerCount',
        'players', 'reveal', 'robber', 'schemaVersion', 'trade', 'turn', 'vp', 'you'].sort(),
    );
    for (const p of v.players) {
      expect(Object.keys(p).sort()).toEqual(['devCardCount', 'discardOwed', 'handCount', 'longestRoad', 'playedDev', 'publicVp', 'seat', 'supply']);
    }
  });

  it('shows your own hand, dev cards and VP; other seats as counts and public fields', () => {
    expect(v.you).toBe(0);
    expect(v.hand).toEqual(s.players[0]!.hand);
    expect(v.devCards).toEqual([{ kind: 'victoryPoint', playableNow: false }]);
    expect(v.vp).toEqual({ public: 3, total: 4 });
    expect(v.players.map((p) => p.handCount)).toEqual([3, 4, 4, 0]);
    expect(v.players.map((p) => p.devCardCount)).toEqual([1, 2, 0, 0]);
    expect(v.players.map((p) => p.publicVp)).toEqual([3, 1, 2, 0]);
    expect(v.players[2]!.playedDev.knight).toBe(3);
    expect(v.devDeckCount).toBe(s.devDeck.length);
    expect(v.bank).toEqual(s.bank);
    expect(v.legal).toEqual(legalActions(s, 0));
    expect(v.reveal).toBeNull();
  });

  it('never contains the deck, RNG state, seeds, or another seat’s hidden cards (denylist)', () => {
    // Board number tokens (board.hexes[].token) are public; auth tokens are named seatToken.
    const DENY = new Set(['devDeck', 'rng', 'seed', 'streamSeeds', 'scripted', 'values', 'then', 'seatToken', 'roomCode', 'hands']);
    const walk = (x: unknown, path: string): void => {
      if (typeof x !== 'object' || x === null) return;
      for (const [k, value] of Object.entries(x)) {
        expect(DENY.has(k), `${path}.${k}`).toBe(false);
        walk(value, `${path}.${k}`);
      }
    };
    for (const seat of SEATS) {
      const w = view(s, seat);
      walk(w, 'view');
      const others = SEATS.filter((o) => o !== seat);
      for (const o of others) expect(w.players[o]).not.toHaveProperty('hand');
      expect(w.devCards).toHaveLength(s.players[seat]!.devCards.length);
    }
    // Seat 0 never learns seat 1's monopoly card or seat 2's bought card.
    expect(JSON.stringify(view(s, 0).devCards)).not.toContain('monopoly');
    expect(view(s, 0).log.map((e) => e.event.kind)).not.toContain('devBoughtDetail');
  });

  it('shows private log details only to the seats involved', () => {
    const kinds = (seat: Seat) => view(s, seat).log.map((e) => e.event.kind);
    expect(kinds(0)).toEqual(['stole', 'stoleDetail', 'devBought']);
    expect(kinds(1)).toEqual(['stole', 'stoleDetail', 'devBought']);
    expect(kinds(2)).toEqual(['stole', 'devBought', 'devBoughtDetail']);
    expect(kinds(3)).toEqual(['stole', 'devBought']);
  });

  it('windows the log by n: only entries with n > logCounter − 100', () => {
    const events: GameEvent[] = Array.from({ length: 150 }, (_, i) => ({ kind: 'turnEnded', seat: 0, turn: i, reason: 'endTurn' }));
    const long = withEvents(buildState(), events);
    const ns = view(long, 1).log.map((e) => e.n);
    expect(ns[0]).toBe(150 - LOG_WINDOW + 1);
    expect(ns.at(-1)).toBe(150);
    expect(ns).toHaveLength(LOG_WINDOW);
  });

  it('reveals hands, dev cards and total VP only in gameOver', () => {
    for (const seat of SEATS) expect(view(s, seat).reveal).toBeNull();
    const over = richState({ name: 'gameOver', winner: 0 });
    for (const seat of SEATS) {
      expect(view(over, seat).reveal).toEqual({
        hands: over.players.map((p) => p.hand),
        devCards: [['victoryPoint'], ['monopoly', 'victoryPoint'], [], []],
        vp: [4, 2, 2, 0],
      });
    }
  });

  it('does not mutate the (deep-frozen) state', () => {
    const before = stateHash(s);
    view(s, 1);
    expect(stateHash(s)).toBe(before);
  });
});

describe('turn.endsAfterDiscards (DR4)', () => {
  const discard = (then: 'moveRobber' | 'autoRobberThenEnd') =>
    buildState({ hands: { 1: { ore: 8 } }, phase: { name: 'discard', owed: [0, 4, 0, 0], then } });

  it('is true only in discard{then: autoRobberThenEnd}, for every seat', () => {
    for (const seat of SEATS) {
      expect(view(discard('autoRobberThenEnd'), seat).turn.endsAfterDiscards).toBe(true);
      expect(view(discard('moveRobber'), seat).turn.endsAfterDiscards).toBe(false);
      expect(view(buildState(), seat).turn.endsAfterDiscards).toBe(false);
      expect(view(buildState({ phase: { name: 'preRoll' } }), seat).turn.endsAfterDiscards).toBe(false);
    }
  });

  it('is derived, not stored: the state and its hash carry no such field', () => {
    const st = discard('autoRobberThenEnd');
    expect(st.turn).not.toHaveProperty('endsAfterDiscards');
    expect(view(st, 0).turn).toEqual({ ...st.turn, endsAfterDiscards: true });
  });

  it('reports what each seat owes', () => {
    expect(view(discard('moveRobber'), 0).players.map((p) => p.discardOwed)).toEqual([0, 4, 0, 0]);
    expect(view(buildState(), 0).players.map((p) => p.discardOwed)).toEqual([0, 0, 0, 0]);
  });
});

describe('publicProjection (design §3.7.1, D7)', () => {
  const s = richState();

  it('omits exactly the private keys and turns log into publicLog', () => {
    const v = view(s, 2);
    const p = publicProjection(v);
    for (const k of PRIVATE_VIEW_KEYS) expect(p).not.toHaveProperty(k);
    expect(Object.keys(p).sort()).toEqual(
      ['awards', 'bank', 'board', 'config', 'devDeckCount', 'phase', 'pieces', 'playerCount', 'players', 'publicLog', 'reveal', 'robber',
        'schemaVersion', 'trade', 'turn'].sort(),
    );
    expect(p.publicLog.map((e) => e.event.kind)).toEqual(['stole', 'devBought']);
    expect(p.turn.endsAfterDiscards).toBe(false);
  });

  it('keeps unknown passthrough keys (projection by omission)', () => {
    const extended = { ...JSON.parse(JSON.stringify(view(s, 0))), futureField: { a: 1 } };
    expect(publicProjection(extended)).toHaveProperty('futureField', { a: 1 });
    expect(publicProjectionHash(extended)).not.toBe(publicProjectionHash(view(s, 0)));
  });

  it('hash = SHA-256 of canonicalJson(publicProjection(v)) and survives a JSON round-trip of the view', () => {
    const v = view(s, 1);
    expect(publicProjectionHash(v)).toBe(sha256Hex(canonicalJson(publicProjection(v))));
    expect(publicProjectionHash(JSON.parse(JSON.stringify(v)))).toBe(publicProjectionHash(v));
  });

  it('differs when public state differs', () => {
    expect(publicProjectionHashOfState(s)).not.toBe(publicProjectionHashOfState(buildState()));
  });
});

describe('publicProjectionHash is equal for every seat (TH13, V16/V29 property)', () => {
  const kinds: DevCardKind[] = ['knight', 'roadBuilding', 'yearOfPlenty', 'monopoly', 'victoryPoint'];
  const seat = fc.constantFrom<Seat>(0, 1, 2, 3);
  const arbState = fc
    .record({
      hands: fc.array(fc.record({ brick: fc.nat(3), lumber: fc.nat(3), wool: fc.nat(3), grain: fc.nat(3), ore: fc.nat(3) }), { minLength: 4, maxLength: 4 }),
      cards: fc.array(fc.array(fc.constantFrom(...kinds), { maxLength: 3 }), { minLength: 4, maxLength: 4 }),
      events: fc.array(
        fc.oneof(
          fc.record({ thief: seat, victim: seat, res: fc.constantFrom('brick', 'ore' as const) }).map(({ thief, victim, res }) => [
            { kind: 'stole', seat: thief, victim } as GameEvent,
            { kind: 'stoleDetail', seat: thief, victim, resource: res } as GameEvent,
          ]),
          fc.record({ buyer: seat, card: fc.constantFrom(...kinds) }).map(({ buyer, card }) => [
            { kind: 'devBought', seat: buyer } as GameEvent,
            { kind: 'devBoughtDetail', seat: buyer, card } as GameEvent,
          ]),
        ),
        { maxLength: 60 },
      ),
      phase: fc.constantFrom<Phase>(
        { name: 'main' },
        { name: 'preRoll' },
        { name: 'discard', owed: [0, 0, 0, 0], then: 'autoRobberThenEnd' },
        { name: 'gameOver', winner: 1 },
      ),
    })
    .map(({ hands, cards, events, phase }) =>
      withEvents(
        buildState({
          hands: Object.fromEntries(hands.map((h, i) => [i, h])),
          devCards: Object.fromEntries(cards.map((c, i) => [i, c.map((kind) => ({ kind, boughtOnTurn: 0 }))])),
          phase,
          allowInvariantViolations: true,
        }),
        events.flat(),
      ),
    );

  it('for all seats and equal to publicProjectionHashOfState', () => {
    fc.assert(
      fc.property(arbState, (st) => {
        const expected = publicProjectionHashOfState(st);
        for (const p of SEATS) expect(publicProjectionHash(view(st, p))).toBe(expected);
      }),
      { numRuns: 200 },
    );
  });
});

describe('victoryPoints (design §6 R14)', () => {
  it('public = settlements + 2·cities + 2 per award; total adds VP cards', () => {
    const s = buildState({
      pieces: [{ seat: 0, settlements: ['v:0,0,N'], cities: ['v:0,1,S'] }],
      devCards: { 0: [{ kind: 'victoryPoint', boughtOnTurn: 0 }, { kind: 'knight', boughtOnTurn: 0 }] },
      playedDev: { 0: { knight: 3 } },
    });
    expect(victoryPoints(s, 0)).toEqual({ public: 1 + 2 + 2, total: 6 });
    expect(victoryPoints(s, 1)).toEqual({ public: 0, total: 0 });
  });
});
